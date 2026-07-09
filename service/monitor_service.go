package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"cc-console/internal/monitor"
	"cc-console/internal/theme"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// MonitorService 是 Wails 服务，所有导出方法自动暴露给前端 JS。
type MonitorService struct {
	app         *application.App
	window      *application.WebviewWindow
	lastRelease *monitor.ReleaseInfo // 缓存最近一次 CheckUpdate 的结果，供下载时取 minisign 签名
	pty         *monitor.PTYRegistry // 内置终端会话注册表（ConPTY）
}

// NewMonitorService 创建服务实例。
func NewMonitorService() *MonitorService {
	return &MonitorService{pty: monitor.GetPTYRegistry()}
}

// SetApp 在 ServiceStartup 中设置 app 引用。
func (s *MonitorService) SetApp(app *application.App, win *application.WebviewWindow) {
	s.app = app
	s.window = win
}

// GetWindow 返回当前窗口引用。
func (s *MonitorService) GetWindow() *application.WebviewWindow {
	return s.window
}

// ---- 数据查询 ----

// DetectResult 是 DetectInstances 的返回结构。
type DetectResult struct {
	Live  []monitor.Instance `json:"live"`
	Stale []monitor.Instance `json:"stale"`
	Stats monitor.StatsInfo  `json:"stats"`
}

// DetectInstances 检测当前所有 Claude Code 实例。
func (s *MonitorService) DetectInstances() (*DetectResult, error) {
	live, stale, err := monitor.Detect()
	if err != nil {
		return nil, err
	}
	offline := 0
	for _, inst := range live {
		if !inst.Live {
			offline++
		}
	}
	return &DetectResult{
		Live:  live,
		Stale: stale,
		Stats: monitor.StatsInfo{
			Online:      len(live),
			Busy:        monitor.CountStatus(live, "busy"),
			Idle:        monitor.CountStatus(live, "idle"),
			Stale:       len(stale),
			Offline:     offline,
			TotalTokens: monitor.TotalTokens(live),
		},
	}, nil
}

// ThemeInfo 返回当前主题信息。
type ThemeInfo struct {
	IsDark bool              `json:"isDark"`
	CSS    map[string]string `json:"css"`
}

// GetTheme 返回当前系统主题状态和 CSS 变量。
func (s *MonitorService) GetTheme() *ThemeInfo {
	dark := theme.IsSystemDarkMode()
	return &ThemeInfo{
		IsDark: dark,
		CSS:    theme.PaletteToCSSMap(dark),
	}
}

// GetClock 返回当前时间字符串。
func (s *MonitorService) GetClock() string {
	return time.Now().Format("15:04:05")
}

// GetAccountUsage 返回当前后端的账号用量（GLM=配额 / DeepSeek=余额），带 120s 内存缓存。
// 缓存感知 settings.json 变化：换后端/换 key 后下一轮轮询即重查。不支持的后端返回 Available=false。
func (s *MonitorService) GetAccountUsage() *monitor.AccountUsage {
	return monitor.GetAccountUsage()
}

// ---- 操作 ----

// ActClear 清空目标实例的对话。
func (s *MonitorService) ActClear(pid int) error {
	return monitor.Injector.SendClear(pid)
}

// ActRewind 回溯目标实例。
func (s *MonitorService) ActRewind(pid int) error {
	return monitor.Injector.SendRewind(pid)
}

// ActPrompt 向目标实例发送文本。
func (s *MonitorService) ActPrompt(pid int, text string) error {
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("输入不能为空")
	}
	flat := strings.ReplaceAll(text, "\r\n", " ")
	flat = strings.ReplaceAll(flat, "\n", " ")
	return monitor.Injector.SendPrompt(pid, flat)
}

// ActAskAnswer 向目标实例发送按键 token 序列，用于驱动 AskUserQuestion 的终端选择 UI。
// actions 是 token 的 JSON 字符串，每个 token 为 {"key":"left|right|up|down|space|tab|enter|backspace|delete|esc|ctrl+a|ctrl+u|ctrl+k|clearInput"}
// 或 {"text":"abc"}。ctrl+u/ctrl+k 用于清空 Type something 当前行残留内容。前端 buildAskSequence/自定义输入流程构造，注入层翻译为方向键/控制键/文本/回车事件。
func (s *MonitorService) ActAskAnswer(pid int, actions string) error {
	if strings.TrimSpace(actions) == "" {
		return fmt.Errorf("actions 不能为空")
	}
	return monitor.Injector.SendAskAnswer(pid, actions)
}

// ActShowWindow 将目标实例的终端窗口置前。
func (s *MonitorService) ActShowWindow(pid int) error {
	return monitor.Injector.ShowWindow(pid)
}

// ActCloseInstance 关闭目标 Claude Code 进程，并尽量关闭其独立终端窗口。
func (s *MonitorService) ActCloseInstance(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("PID 无效")
	}
	return monitor.Injector.CloseInstance(pid)
}

// GetChatHistory 返回指定 PID 实例的完整会话消息历史（含工具调用/结果）。
func (s *MonitorService) GetChatHistory(pid int) (*monitor.ChatHistoryResult, error) {
	si, ok := monitor.GetCachedSession(pid)
	if !ok {
		return nil, fmt.Errorf("未找到 PID %d 的会话（实例可能已退出）", pid)
	}
	result := monitor.GetChatHistory(si)
	// PendingAsk 实时读 ask/<pid>.json，绝不进 GetChatHistory 的 mtime 缓存——
	// ask 文件从有→无（用户答完）必须即时反映，而 JSONL 的 hash 未变时缓存会直接 return。
	if rec, ok := monitor.ReadAsk(si.Pid); ok {
		result.PendingAsk = &rec
	}
	return &result, nil
}

// GetCommandSuggestions 返回该实例可用的斜杠命令/技能列表（内置 + 项目 + 用户 + 插件），
// 供消息框输入 / 时自动补全。pid 找不到会话时 cwd 留空，仅返回内置 + 用户级条目。
func (s *MonitorService) GetCommandSuggestions(pid int) []monitor.CommandSuggestion {
	cwd := ""
	if si, ok := monitor.GetCachedSession(pid); ok {
		cwd = si.Cwd
	}
	return monitor.GetCommandSuggestions(cwd)
}

// SaveTextFile 弹出系统原生保存框，把前端传入的文本保存为本地文件。
// 取消保存返回空字符串；成功返回最终路径。
func (s *MonitorService) SaveTextFile(filename string, content string) (string, error) {
	if s.app == nil {
		return "", fmt.Errorf("应用未初始化")
	}
	filename = strings.TrimSpace(filename)
	if filename == "" {
		filename = "cc-console-message.md"
	}
	path, err := s.app.Dialog.SaveFile().
		SetMessage("保存 Markdown 文件").
		SetFilename(filename).
		CanCreateDirectories(true).
		PromptForSingleSelection()
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		return "", err
	}
	return path, nil
}

// ---- 实例启动 ----

// GetRecentDirs 返回最近工作目录（去重，最多 8 个，最近在前）。
func (s *MonitorService) GetRecentDirs() []string {
	return monitor.GetRecentDirs()
}

// PickDirectory 弹出系统原生文件夹选择框，返回选中路径。
// 取消返回 ("", nil)；出错返回 ("", err)。默认定位到最近目录的第一项。
func (s *MonitorService) PickDirectory() (string, error) {
	if s.app == nil {
		return "", fmt.Errorf("应用未初始化")
	}
	opts := &application.OpenFileDialogOptions{
		CanChooseDirectories: true,
		CanChooseFiles:       false,
		CanCreateDirectories: true,
		Title:                "选择 Claude Code 工作目录",
	}
	if dirs := monitor.GetRecentDirs(); len(dirs) > 0 {
		opts.Directory = dirs[0] // 默认定位到最近目录，提升选择体验
	}
	return s.app.Dialog.OpenFileWithOptions(opts).PromptForSingleSelection()
}

// LaunchInstance 在 workdir 用新终端窗口启动 claude，并把 workdir 记入最近目录。
// workdir 为空时内部弹出原生文件夹选择框；用户取消时返回 ("", nil)（非错误）。
// 返回 (usedTerminal, error)：前端用 usedTerminal 做 flashFoot 反馈。
// 窗口模式：show=可见窗口，hide=最小化到任务栏（可点开查看 claude 运行状态/错误）。
func (s *MonitorService) LaunchInstance(workdir string) (string, error) {
	if strings.TrimSpace(workdir) == "" {
		var err error
		workdir, err = s.PickDirectory()
		if err != nil {
			return "", err
		}
		if workdir == "" {
			return "", nil // 用户取消，不算错误
		}
	}
	mode := monitor.GetSettings().LaunchWindowMode
	if mode == "" || mode == "minimize" {
		mode = "hide"
	}

	// 内置终端：在应用内 ConPTY 跑 claude，不开外部窗口。
	// ConPTY 不可用（老系统）→ 静默回退外部窗口（graceful）；
	// ConPTY 可用但启动失败（如 claude 未安装）→ 报错给前端，不静默开 PowerShell（避免「设了内置却弹外部」的困惑）。
	if mode == "embedded" {
		if !monitor.ConPTYSupported() {
			// 老系统无 ConPTY → 回退最小化外部窗口
			mode = "hide"
		} else {
			sid, err := s.StartTerminal("claude", workdir)
			if err != nil {
				return "", err // 明确报错，让前端提示用户
			}
			if _, e := monitor.AddRecentDir(workdir); e != nil {
				fmt.Println("记录最近目录失败:", e)
			}
			return fmt.Sprintf(`{"embedded":true,"sessionId":%q}`, sid), nil
		}
	}
	used, err := monitor.LaunchClaudeInDir(workdir, mode)
	if err != nil {
		return "", err
	}
	// 记入最近目录（失败不致命，不影响启动结果）
	if _, e := monitor.AddRecentDir(workdir); e != nil {
		fmt.Println("记录最近目录失败:", e)
	}
	return used, nil
}

// ---- 内置终端（ConPTY）----
//
// 内置终端在应用内跑伪终端：claude/pwsh/cmd 作为 ConPTY 子进程，前端用 xterm.js 渲染。
// Go→前端输出走 Wails 事件 term:output（高频），前端→Go 输入走以下绑定方法（请求-响应）。
// claude 子进程仍照常写 ~/.claude/sessions/*.json 与 JSONL，现有监控/检测逻辑零改动。

// StartTerminal 启动一个内置终端会话。
//   - kind: "claude" | "pwsh" | "cmd" | "shell"
//   - workdir: 工作目录（必须存在）
//
// 返回 session id（形如 term-N）。前端拿到后新建 xterm tab 并订阅 term:output 事件。
func (s *MonitorService) StartTerminal(kind string, workdir string) (string, error) {
	kind = strings.TrimSpace(kind)
	if kind == "" {
		kind = "shell"
	}
	if workdir = strings.TrimSpace(workdir); workdir != "" {
		if info, err := os.Stat(workdir); err != nil || !info.IsDir() {
			return "", fmt.Errorf("工作目录不存在或不是目录: %s", workdir)
		}
	}

	cmdline, err := buildTerminalCmdline(kind, workdir)
	if err != nil {
		return "", err
	}

	var sid string
	sid, err = s.pty.StartPTYSession(kind, workdir, cmdline, 80, 24,
		// onData：子进程输出片段 → 推给前端对应 tab
		func(data string) {
			if s.window != nil {
				s.window.EmitEvent("term:output", map[string]any{"id": sid, "data": data})
			}
		},
		// onExit：子进程退出 → 推退出码 + 从注册表移除
		func(code int) {
			if s.window != nil {
				s.window.EmitEvent("term:exit", map[string]any{"id": sid, "exitCode": code})
			}
			s.pty.Remove(sid)
		},
	)
	return sid, err
}

// buildTerminalCmdline 按 kind 拼接可执行文件命令行（含绝对路径，CreateProcessW 需要）。
func buildTerminalCmdline(kind, workdir string) (string, error) {
	if runtime.GOOS == "darwin" {
		return buildTerminalCmdlineDarwin(kind)
	}
	switch kind {
	case "claude":
		return buildClaudeCmdline()
	case "pwsh":
		return fmt.Sprintf(`"%s" -NoLogo`, monitor.ResolveShellExe()), nil
	case "cmd":
		// cmd 默认 GBK 输出，启动时 chcp 65001 强制 UTF-8，避免中文乱码。
		return `cmd.exe /K chcp 65001 >nul`, nil
	case "shell", "":
		return fmt.Sprintf(`"%s" -NoLogo`, monitor.ResolveShellExe()), nil
	default:
		return "", fmt.Errorf("未知终端类型: %s", kind)
	}
}

// buildTerminalCmdlineDarwin macOS 终端命令行（交给 /bin/sh -c 执行）。
func buildTerminalCmdlineDarwin(kind string) (string, error) {
	switch kind {
	case "claude":
		return buildClaudeCmdline()
	case "shell", "":
		sh := monitor.ResolveShellExe()
		if sh == "" {
			sh = "/bin/zsh"
		}
		return sh, nil
	default:
		return "", fmt.Errorf("macOS 不支持终端类型: %s", kind)
	}
}

// buildClaudeCmdline 解析 claude 并构造命令行。
//
// 关键：Windows 上 claude 必须经 claude.cmd 包装器启动才会正常写 session/JSONL（供监控识别）。
// 直接 spawn claude.exe（绕过包装器）能跑、能响应，但【不落 session 文件】，导致实例无法被检测。
// 所以优先找 claude.cmd，用 cmd.exe /c 包一层运行（CreateProcessW 不能直接跑 .cmd）；
// 实在找不到 .cmd 才回退 raw claude.exe（次优，可能不被监控识别）。
//
// 解析顺序：PATH → %APPDATA%\npm（npm 全局，GUI 进程 PATH 可能不含此目录）。
func buildClaudeCmdline() (string, error) {
	args := monitor.BuildClaudeArgsForPTY()
	argSuffix := ""
	if args != "" {
		argSuffix = " " + args
	}

	if runtime.GOOS == "darwin" {
		// macOS：claude 是编译二进制，LookPath 直接命中（无 .cmd 包装器）。
		if p, err := exec.LookPath("claude"); err == nil {
			return fmt.Sprintf("%s%s", p, argSuffix), nil
		}
		return "", fmt.Errorf("未找到 claude 可执行文件，请确认 Claude Code 已安装且位于 PATH")
	}

	// 1. 收集 claude.cmd 候选（包装器，优先）。
	var cmdCandidates []string
	addCmd := func(p string) {
		if p != "" && extIs(p, ".cmd", ".bat") {
			cmdCandidates = append(cmdCandidates, p)
		}
	}
	if p, err := exec.LookPath("claude.cmd"); err == nil {
		addCmd(p)
	}
	if p, err := exec.LookPath("claude"); err == nil {
		addCmd(p) // LookPath 命中 claude.cmd 时 p 带 .cmd 扩展名
	}
	if appdata := os.Getenv("APPDATA"); appdata != "" {
		cmdCandidates = append(cmdCandidates, filepath.Join(appdata, "npm", "claude.cmd"))
	}
	for _, p := range cmdCandidates {
		if p == "" {
			continue
		}
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			// 经 cmd.exe /c 跑包装器，与外部启动（pwsh→claude→claude.cmd→claude.exe）等价。
			return fmt.Sprintf(`cmd.exe /c "%s"%s`, p, argSuffix), nil
		}
	}

	// 2. 回退：raw claude.exe（次优，可能不被监控识别）。
	var exeCandidates []string
	if p, err := exec.LookPath("claude.exe"); err == nil {
		exeCandidates = append(exeCandidates, p)
	}
	if appdata := os.Getenv("APPDATA"); appdata != "" {
		exeCandidates = append(exeCandidates, filepath.Join(appdata, "npm", "claude.exe"))
	}
	if home, err := os.UserHomeDir(); err == nil {
		exeCandidates = append(exeCandidates,
			filepath.Join(home, ".local", "bin", "claude.exe"),
			filepath.Join(home, "bin", "claude.exe"),
		)
	}
	for _, p := range exeCandidates {
		if p == "" {
			continue
		}
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return fmt.Sprintf(`"%s"%s`, p, argSuffix), nil
		}
	}
	return "", fmt.Errorf("未找到 claude 可执行文件，请确认 Claude Code 已安装（npm i -g @anthropic-ai/claude-code 或官方安装器）且位于 PATH / %APPDATA%\\npm")
}

// extIs 判断 path 扩展名是否匹配任一后缀（大小写不敏感）。
func extIs(p string, exts ...string) bool {
	e := strings.ToLower(filepath.Ext(p))
	for _, x := range exts {
		if e == x {
			return true
		}
	}
	return false
}

// WriteTerminal 把前端键盘输入（xterm.js onData）写给指定终端。
func (s *MonitorService) WriteTerminal(id string, data string) error {
	return s.pty.Write(id, []byte(data))
}

// ResizeTerminal 调整终端尺寸（xterm.js cols/rows 变化时）。
func (s *MonitorService) ResizeTerminal(id string, cols int, rows int) error {
	return s.pty.Resize(id, cols, rows)
}

// KillTerminal 终止指定终端会话（前端关 tab）。
func (s *MonitorService) KillTerminal(id string) error {
	s.pty.Kill(id)
	return nil
}

// ListTerminals 列出所有活跃内置终端（前端列 tab / 调试用）。
func (s *MonitorService) ListTerminals() []monitor.TerminalInfo {
	return s.pty.List()
}

// CloseAllTerminals 关闭所有内置终端（应用退出前调用）。
func (s *MonitorService) CloseAllTerminals() {
	if s.pty != nil {
		s.pty.CloseAll()
	}
}

// ---- statusline 桥接 ----

// BridgeInfo 返回 statusline 桥接的配置状态 + 当前实时接入比例。
type BridgeInfo struct {
	monitor.BridgeStatus
	HookedCount int `json:"hookedCount"` // 有新鲜 live 文件的实例数(实时接入)
	Total       int `json:"total"`       // 在线实例总数
}

// GetBridgeStatus 返回桥接状态及当前接入比例。
func (s *MonitorService) GetBridgeStatus() (*BridgeInfo, error) {
	st := monitor.GetBridgeStatus()
	live, _, _ := monitor.Detect()
	hooked := 0
	for _, inst := range live {
		if inst.Live {
			hooked++
		}
	}
	return &BridgeInfo{BridgeStatus: st, HookedCount: hooked, Total: len(live)}, nil
}

// EnableBridge 启用桥接:保存设置并写入 ~/.claude/settings.json。
func (s *MonitorService) EnableBridge() error {
	cfg := monitor.GetSettings()
	cfg.BridgeEnabled = true
	if err := monitor.SaveSettings(cfg); err != nil {
		return err
	}
	_, err := monitor.EnsureBridge()
	return err
}

// DisableBridge 禁用桥接:还原 settings.json 并保存设置。
func (s *MonitorService) DisableBridge() error {
	cfg := monitor.GetSettings()
	cfg.BridgeEnabled = false
	if err := monitor.SaveSettings(cfg); err != nil {
		return err
	}
	return monitor.DisableBridge()
}

// ---- 设置 ----

// SettingsResult 返回给前端的设置数据。
type SettingsResult struct {
	CloseQuits               bool   `json:"closeQuits"`
	AutoStart                bool   `json:"autoStart"`
	Version                  string `json:"version"`
	LaunchWindowMode         string `json:"launchWindowMode"`         // embedded 应用内置 / show 显示窗口 / hide 最小化到任务栏
	EmbeddedAvailable        bool   `json:"embeddedAvailable"`        // 当前系统是否支持内置终端（ConPTY），前端据此灰显选项
	EnterToSend              bool   `json:"enterToSend"`              // 回车直接发送
	LaunchYolo               bool   `json:"launchYolo"`               // 新建实例使用 bypassPermissions 模式
	AutoCheckClaudeSettings  bool   `json:"autoCheckClaudeSettings"`  // 每 10 秒检查 ~/.claude/settings.json
	AutoRepairClaudeSettings bool   `json:"autoRepairClaudeSettings"` // settings.json 漂移时自动修复
	SortField                string `json:"sortField"`                // 实例列表排序字段（updatedAt | startedAt | contextTokens）
	SortDir                  string `json:"sortDir"`                  // 排序方向（asc | desc）
	ViewMode                 string `json:"viewMode"`                 // 主区布局（list | chat）
	ShowSessionSubtitle      bool   `json:"showSessionSubtitle"`      // 会话标签是否显示目录副标题
}

// Version 应用版本号。
const Version = "1.5.1"

// GetSettings 返回当前设置。
func (s *MonitorService) GetSettings() *SettingsResult {
	cfg := monitor.GetSettings()
	auto, _ := monitor.IsAutoStartEnabled()
	mode := cfg.LaunchWindowMode
	if mode == "" || mode == "minimize" {
		mode = "hide" // 默认最小化到任务栏；兼容旧配置 minimize 值
	}
	sortField := cfg.SortField
	if sortField == "" {
		sortField = "startedAt" // 默认排序：建立时间
	}
	sortDir := cfg.SortDir
	if sortDir == "" {
		sortDir = "desc"
	}
	viewMode := cfg.ViewMode
	if viewMode != "list" && viewMode != "chat" {
		viewMode = "chat" // 默认会话布局；兼容旧配置缺省值
	}
	return &SettingsResult{
		CloseQuits:               cfg.CloseQuits,
		AutoStart:                auto,
		Version:                  Version,
		LaunchWindowMode:         mode,
		EmbeddedAvailable:        monitor.ConPTYSupported(),
		EnterToSend:              cfg.EnterToSend,
		LaunchYolo:               cfg.LaunchYolo,
		AutoCheckClaudeSettings:  cfg.AutoCheckClaudeSettings,
		AutoRepairClaudeSettings: cfg.AutoRepairClaudeSettings,
		SortField:                sortField,
		SortDir:                  sortDir,
		ViewMode:                 viewMode,
		ShowSessionSubtitle:      cfg.ShowSessionSubtitle,
	}
}

// SaveListPrefs 持久化实例列表视图偏好（排序字段 + 方向 + 布局模式），下次启动沿用。
// 与 SaveSettings 分离：列表视图状态独立保存，避免扰动其它设置项。
func (s *MonitorService) SaveListPrefs(sortField, sortDir, viewMode string, showSessionSubtitle bool) error {
	cfg := monitor.GetSettings()
	cfg.SortField = sortField
	cfg.SortDir = sortDir
	cfg.ViewMode = viewMode
	cfg.ShowSessionSubtitle = showSessionSubtitle
	return monitor.SaveSettings(cfg)
}

// SaveSettings 保存设置并同步开机自启状态。launchMode 为启动终端窗口模式（show/minimize/hide）。
// enterToSend 控制消息框发送键：true=回车发送（Shift+回车换行），false=回车换行（Shift+回车发送）。
// launchYolo 控制新建实例是否使用 --permission-mode bypassPermissions。
func (s *MonitorService) SaveSettings(closeQuits bool, autoStart bool, launchMode string, enterToSend bool, launchYolo bool, autoCheckClaudeSettings bool, autoRepairClaudeSettings bool) error {
	cfg := monitor.GetSettings()
	cfg.CloseQuits = closeQuits
	cfg.AutoStart = autoStart
	cfg.LaunchWindowMode = launchMode
	cfg.EnterToSend = enterToSend
	cfg.LaunchYolo = launchYolo
	cfg.AutoCheckClaudeSettings = autoCheckClaudeSettings
	cfg.AutoRepairClaudeSettings = autoRepairClaudeSettings
	if err := monitor.SetAutoStart(autoStart); err != nil {
		return err
	}
	return monitor.SaveSettings(cfg)
}

// GetBridgeRules 返回 settings.json 自动检查/自动修复说明弹窗所需的数据。
func (s *MonitorService) GetBridgeRules() *monitor.BridgeRules {
	rules := monitor.GetBridgeRules()
	return &rules
}

// ShouldQuitOnClose 返回关闭按钮是否应直接退出。
func (s *MonitorService) ShouldQuitOnClose() bool {
	return monitor.IsCloseQuit()
}

// OpenURL 在系统默认浏览器中打开 URL。
func (s *MonitorService) OpenURL(url string) error {
	return monitor.OpenInBrowser(url)
}

// CheckUpdate 检查 GitHub 最新版本。
// 返回 (info, nil) 表示有新版本可用；
// 返回 (nil, nil) 表示已是最新；
// 返回 (nil, error) 表示检查失败（网络/API 错误）。
func (s *MonitorService) CheckUpdate() (*monitor.ReleaseInfo, error) {
	info, err := monitor.CheckLatestRelease()
	if err != nil {
		return nil, err
	}
	if info == nil || !monitor.IsNewer(info.Version, Version) {
		s.lastRelease = nil
		return nil, nil
	}
	s.lastRelease = info
	return info, nil
}

// DownloadUpdate 下载并应用更新。异步执行，通过 Events 推送进度，立即返回。
func (s *MonitorService) DownloadUpdate(url string) error {
	go func() {
		onProgress := func(downloaded, total int64) {
			pct := 0
			if total > 0 {
				pct = int(downloaded * 100 / total)
			}
			s.window.EmitEvent("update:progress", map[string]any{
				"status":     "downloading",
				"downloaded": downloaded,
				"total":      total,
				"percent":    pct,
			})
		}
		signature := ""
		if s.lastRelease != nil {
			signature = s.lastRelease.Signature
		}
		if err := monitor.DownloadAndReplace(url, signature, onProgress); err != nil {
			s.window.EmitEvent("update:progress", map[string]any{
				"status":  "error",
				"message": err.Error(),
			})
		}
	}()
	return nil
}
