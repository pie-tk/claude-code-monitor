package monitor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// statusline 桥接:利用 Claude Code 的 statusLine 通道获取活跃会话的实时数据。
//
// 背景:Claude Code 2.1.177+ 活跃会话不落盘 jsonl,实时 token/上下文只能通过
// statusline 通道获取。cc-console-sl.exe 作为 statusLine 命令,把每次刷新推送的
// 状态落盘到 ~/.cc-console/live/<pid>.json,本包负责读取这些文件并在 Detect 中
// 按 pid 精确还原每个实例的实时状态。
//
// 本文件含跨平台逻辑(live 文件读写 + settings.json 的 statusLine 字段操作)。
// 平台特定的 processCmdline 在 bridge_windows.go / bridge_other.go。

// LiveRecord 对应 slhook 写入的 live/<pid>.json(两端 JSON tag 必须一致)。
type LiveRecord struct {
	Pid            int     `json:"pid"`
	Ts             int64   `json:"ts"` // slhook 写入时刻(epoch ms)
	SessionID      string  `json:"sessionId"`
	SessionName    string  `json:"sessionName"`
	Model          string  `json:"model"`
	ModelID        string  `json:"modelId"`
	Cwd            string  `json:"cwd"`
	TranscriptPath string  `json:"transcriptPath"`
	ContextTokens  int64   `json:"contextTokens"`
	ContextPercent int     `json:"contextPercent"`
	ContextLimit   int64   `json:"contextLimit"`
	Version        string  `json:"version"`
	CostUsd        float64 `json:"costUsd"`
	DurationMs     int64   `json:"durationMs"`
}

// HookState 对应 slhook 写入的 hook/<pid>.json，用于权威记录 Claude Code 生命周期事件。
type HookState struct {
	Pid            int    `json:"pid"`
	Ts             int64  `json:"ts"`
	SessionID      string `json:"sessionId"`
	TranscriptPath string `json:"transcriptPath"`
	Cwd            string `json:"cwd"`
	LastEvent      string `json:"lastEvent"`
	Phase          string `json:"phase"`
	ToolName       string `json:"toolName"`
	ToolDepth      int    `json:"toolDepth"`
	TaskStartedAt  int64  `json:"taskStartedAt"`
}

// AskRecord 对应 slhook 写入的 ask/<pid>.json，捕获活跃会话挂起的 AskUserQuestion。
// Claude Code 2.1.169+ 活跃会话不落盘 JSONL，AskUserQuestion 的 questions 只能由
// PreToolUse hook 实时捕获，这是前端渲染选择按钮的唯一实时来源。两端 JSON tag 必须与
// cmd/slhook 的 askRecord 一致。Questions 原样透传 tool_input.questions（不解析，
// 避免 AskUserQuestion option 结构差异导致丢字段）。
type AskRecord struct {
	Pid       int             `json:"pid"`
	Ts        int64           `json:"ts"` // slhook 写入时刻(epoch ms)
	ToolUseID string          `json:"toolUseId"`
	Questions json.RawMessage `json:"questions"`
}

const (
	liveFreshMs int64 = 60000 // live 文件 mtime 距 now < 60s 视为新鲜(idle 时 statusline 刷新频率低,放宽容忍)
	liveBusyMs  int64 = 3000  // live 文件 mtime 距 now < 3s 视为 busy(statusline 正频繁刷新)
)

var lifecycleHookEvents = []string{"UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"}

const (
	bridgeMjsName = "bridge.mjs"
	slhookMarker  = "bridge.mjs" // statusLine.command 含此串即表示已由我们接管(node 入口)
	hookModeArg   = "--hook"
)

// slhookExeName / hookCommandTag 平台相关：Windows 为 cc-console-sl.exe，其它平台无 .exe。
// 用 var + init 分支（const 无法按运行时平台取值）。
var (
	slhookExeName  = "cc-console-sl.exe"
	hookCommandTag = "cc-console-sl.exe"
)

func init() {
	if runtime.GOOS != "windows" {
		slhookExeName = "cc-console-sl"
		hookCommandTag = "cc-console-sl"
	}
}

// processCmdline 返回 pid 的命令行(小写),失败返回 ""。平台特定。
var processCmdline func(pid int) string

// appDataDir 返回应用数据目录 ~/.cc-console/（live/hook/logs/orig-statusline.json 等）。
func appDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".cc-console")
}

// LiveDir 返回 live 文件目录。
func LiveDir() string {
	d := appDataDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "live")
}

// HookDir 返回 lifecycle hook 状态文件目录。
func HookDir() string {
	d := appDataDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "hook")
}

// LivePath 返回 pid 对应的 live 文件路径。
func LivePath(pid int) string {
	d := LiveDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, strconv.Itoa(pid)+".json")
}

// HookPath 返回 pid 对应的 hook 状态文件路径。
func HookPath(pid int) string {
	d := HookDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, strconv.Itoa(pid)+".json")
}

// AskDir 返回 AskUserQuestion 挂起态文件目录。
func AskDir() string {
	d := appDataDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "ask")
}

// AskPath 返回 pid 对应的 ask 文件路径。
func AskPath(pid int) string {
	d := AskDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, strconv.Itoa(pid)+".json")
}

// ReadLive 读取并解析 pid 的 live 文件。
// 返回:记录、文件 mtime(epoch ms)、是否新鲜、是否成功解析。
func ReadLive(pid int, nowMs int64) (rec LiveRecord, mtimeMs int64, fresh bool, ok bool) {
	path := LivePath(pid)
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	mtimeMs = info.ModTime().UnixMilli()
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	if json.Unmarshal(data, &rec) != nil {
		return
	}
	ok = true
	fresh = nowMs-mtimeMs < liveFreshMs
	return
}

// CleanLiveFiles 删除不在 alivePids 中的 live 文件(对应进程已退出)。
func CleanLiveFiles(alivePids map[int]bool) {
	cleanPidFiles(LiveDir(), alivePids)
}

// ReadHookState 读取并解析 pid 的 hook 状态文件。
func ReadHookState(pid int) (state HookState, mtimeMs int64, ok bool) {
	path := HookPath(pid)
	if path == "" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	mtimeMs = info.ModTime().UnixMilli()
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	if json.Unmarshal(data, &state) != nil {
		return
	}
	ok = true
	return
}

// CleanHookFiles 删除不在 alivePids 中的 hook 状态文件(对应进程已退出)。
func CleanHookFiles(alivePids map[int]bool) {
	cleanPidFiles(HookDir(), alivePids)
}

// ReadAsk 读取并解析 pid 的 ask 文件（挂起的 AskUserQuestion）。
// 返回记录与是否成功解析；文件不存在/解析失败返回 ok=false。
func ReadAsk(pid int) (AskRecord, bool) {
	var rec AskRecord
	path := AskPath(pid)
	if path == "" {
		return rec, false
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return rec, false
	}
	if json.Unmarshal(data, &rec) != nil {
		return rec, false
	}
	return rec, true
}

// CleanAskFiles 删除不在 alivePids 中的 ask 文件(对应进程已退出)。
func CleanAskFiles(alivePids map[int]bool) {
	cleanPidFiles(AskDir(), alivePids)
}

func cleanPidFiles(dir string, alivePids map[int]bool) {
	if dir == "" {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil {
			continue
		}
		if !alivePids[pid] {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// ---- settings.json 的 statusLine / lifecycle hooks 操作 ----

func claudeSettingsPath() string {
	d := claudeDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "settings.json")
}

func origStatuslinePath() string {
	d := appDataDir()
	if d == "" {
		return ""
	}
	return filepath.Join(d, "orig-statusline.json")
}

// slhookExePath 返回监控器 exe 同目录下的 cc-console-sl.exe 绝对路径(不存在则空)。
func slhookExePath() string {
	dir := monitorExeDir()
	if dir == "" {
		return ""
	}
	p := filepath.Join(dir, slhookExeName)
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// bridgeMjsPath 返回监控器 exe 同目录下的 bridge.mjs 绝对路径(不存在则空)。
func bridgeMjsPath() string {
	dir := monitorExeDir()
	if dir == "" {
		return ""
	}
	p := filepath.Join(dir, bridgeMjsName)
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

// monitorExeDir 返回监控器 exe 所在目录。
func monitorExeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

// readSettingsJSON 读取并解析 settings.json,容忍 UTF-8 BOM(PowerShell 等工具可能写入)。
func readSettingsJSON(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]any{}, nil // 不存在 → 空,EnsureBridge 会创建
		}
		return nil, err
	}
	raw = bytes.TrimPrefix(raw, []byte{0xEF, 0xBB, 0xBF}) // 去 UTF-8 BOM
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, err
	}
	if cfg == nil {
		cfg = map[string]any{}
	}
	return cfg, nil
}

// getStatuslineCommand 从解析后的 settings.json map 中取 statusLine.command。
func getStatuslineCommand(cfg map[string]any) string {
	sl, ok := cfg["statusLine"].(map[string]any)
	if !ok {
		return ""
	}
	cmd, _ := sl["command"].(string)
	return cmd
}

func hookCommand(event string) string {
	exe := slhookExePath()
	if exe == "" {
		return ""
	}
	return `"` + strings.ReplaceAll(exe, `\`, `/`) + `" ` + hookModeArg + ` ` + event
}

func hookEntry(event string) map[string]any {
	hook := map[string]any{
		"type":    "command",
		"command": hookCommand(event),
	}
	group := map[string]any{"hooks": []any{hook}}
	if event == "PreToolUse" || event == "PostToolUse" {
		group["matcher"] = "*"
	}
	return group
}

func hookEventGroups(cfg map[string]any, event string) []any {
	hooks, ok := cfg["hooks"].(map[string]any)
	if !ok {
		return nil
	}
	groups, _ := hooks[event].([]any)
	return groups
}

func isMonitorHookCommand(cmd string) bool {
	low := strings.ToLower(cmd)
	return strings.Contains(low, strings.ToLower(hookCommandTag)) && strings.Contains(low, strings.ToLower(hookModeArg))
}

func hasMonitorHook(event string, groups []any) bool {
	for _, g := range groups {
		gm, ok := g.(map[string]any)
		if !ok {
			continue
		}
		hs, _ := gm["hooks"].([]any)
		for _, h := range hs {
			hm, ok := h.(map[string]any)
			if !ok {
				continue
			}
			cmd, _ := hm["command"].(string)
			if isMonitorHookCommand(cmd) && strings.Contains(strings.ToLower(cmd), strings.ToLower(event)) {
				return true
			}
		}
	}
	return false
}

func ensureLifecycleHooks(cfg map[string]any) bool {
	hooks, ok := cfg["hooks"].(map[string]any)
	if !ok || hooks == nil {
		hooks = map[string]any{}
		cfg["hooks"] = hooks
	}
	changed := false
	for _, event := range lifecycleHookEvents {
		groups, _ := hooks[event].([]any)
		if hasMonitorHook(event, groups) {
			continue
		}
		hooks[event] = append(groups, hookEntry(event))
		changed = true
	}
	return changed
}

func removeLifecycleHooks(cfg map[string]any) bool {
	hooks, ok := cfg["hooks"].(map[string]any)
	if !ok {
		return false
	}
	changed := false
	for _, event := range lifecycleHookEvents {
		groups, _ := hooks[event].([]any)
		if len(groups) == 0 {
			continue
		}
		var kept []any
		for _, g := range groups {
			gm, ok := g.(map[string]any)
			if !ok {
				kept = append(kept, g)
				continue
			}
			hs, _ := gm["hooks"].([]any)
			var keptHooks []any
			for _, h := range hs {
				hm, ok := h.(map[string]any)
				if !ok {
					keptHooks = append(keptHooks, h)
					continue
				}
				cmd, _ := hm["command"].(string)
				if isMonitorHookCommand(cmd) {
					changed = true
					continue
				}
				keptHooks = append(keptHooks, h)
			}
			if len(keptHooks) == 0 {
				changed = true
				continue
			}
			gm["hooks"] = keptHooks
			kept = append(kept, gm)
		}
		if len(kept) == 0 {
			delete(hooks, event)
			continue
		}
		hooks[event] = kept
	}
	if len(hooks) == 0 {
		delete(cfg, "hooks")
	}
	return changed
}

func saveOrigStatusline(cmd string) {
	p := origStatuslinePath()
	if p == "" || cmd == "" {
		return
	}
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	data, _ := json.MarshalIndent(struct {
		Command string `json:"command"`
	}{Command: cmd}, "", "  ")
	_ = os.WriteFile(p, data, 0o644)
}

func readOrigStatusline() string {
	data, err := os.ReadFile(origStatuslinePath())
	if err != nil {
		return ""
	}
	var o struct {
		Command string `json:"command"`
	}
	if json.Unmarshal(data, &o) != nil {
		return ""
	}
	return o.Command
}

// EnsureBridge 把 ~/.claude/settings.json 的 statusLine 指向 slhook,并安装 lifecycle hooks。
// 幂等:已指向自己且 hooks 已存在则不动作。返回 (是否做了修改, error)。
func EnsureBridge() (bool, error) {
	bridgePath := bridgeMjsPath()
	if bridgePath == "" {
		return false, fmt.Errorf("未找到 %s(请确认与监控器在同一目录)", bridgeMjsName)
	}
	if slhookExePath() == "" {
		return false, fmt.Errorf("未找到 %s", slhookExeName)
	}
	path := claudeSettingsPath()
	if path == "" {
		return false, fmt.Errorf("无法定位 ~/.claude")
	}

	cfg, err := readSettingsJSON(path)
	if err != nil {
		return false, fmt.Errorf("读取 settings.json 失败: %w", err)
	}

	bridgeFwd := strings.ReplaceAll(bridgePath, `\`, `/`)
	cur := getStatuslineCommand(cfg)
	changed := false
	// 已指向本监控器的 bridge(完整路径匹配)才跳过;不同路径的 bridge.mjs(如开发版残留)会被更新到自己的
	if !(cur != "" && strings.Contains(strings.ToLower(cur), strings.ToLower(bridgeFwd))) {
		// 备份原值(仅首次,避免覆盖用户后续手动改动)
		if cur != "" {
			if _, err := os.Stat(origStatuslinePath()); os.IsNotExist(err) {
				saveOrigStatusline(cur)
			}
		}
		// Claude Code 2.1.x 只执行 `node "mjs"` 形式的 statusLine(实测 exe 形式不被调用),
		// 故入口为 bridge.mjs;它再 spawn slhook.exe(写 live)+ 链式原 statusLine。路径用正斜杠。
		cfg["statusLine"] = map[string]any{
			"type":    "command",
			"command": `node "` + bridgeFwd + `"`,
		}
		changed = true
	}
	if ensureLifecycleHooks(cfg) {
		changed = true
	}
	if !changed {
		return false, nil
	}
	return writeSettings(path, cfg)
}

// DisableBridge 从 orig-statusline.json 还原 statusLine，并移除本应用写入的 lifecycle hooks。
func DisableBridge() error {
	path := claudeSettingsPath()
	cfg, err := readSettingsJSON(path)
	if err != nil {
		return err
	}
	changed := removeLifecycleHooks(cfg)
	cur := getStatuslineCommand(cfg)
	if strings.Contains(strings.ToLower(cur), slhookMarker) {
		if orig := readOrigStatusline(); orig != "" {
			cfg["statusLine"] = map[string]any{"type": "command", "command": orig}
		} else {
			delete(cfg, "statusLine")
		}
		changed = true
	}
	if !changed {
		return nil
	}
	_, err = writeSettings(path, cfg)
	return err
}

// writeSettings 原子写回 settings.json(保留所有字段 + 2 空格缩进,与 Claude Code 一致)。
func writeSettings(path string, cfg map[string]any) (bool, error) {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return false, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return false, err
	}
	if err := os.Rename(tmp, path); err != nil {
		return false, err
	}
	return true, nil
}

// BridgeStatus 是前端查询桥接状态的返回结构。
type BridgeStatus struct {
	Enabled        bool   `json:"enabled"`        // 用户设置是否启用桥接
	Installed      bool   `json:"installed"`      // slhook exe 存在
	Hooked         bool   `json:"hooked"`         // settings.json 的 statusLine 已指向 slhook
	HooksInstalled bool   `json:"hooksInstalled"` // lifecycle hooks 已安装
	OrigCmd        string `json:"origCmd"`        // 备份的原命令(前端展示/确认用)
}

// BridgeRules 返回 settings.json 管理说明弹窗所需的动态规则与可复制配置片段。
type BridgeRules struct {
	ClaudeSettingsPath string            `json:"claudeSettingsPath"`
	BackupPath         string            `json:"backupPath"`
	StatusLineCommand  string            `json:"statusLineCommand"`
	StatusLineJSON     string            `json:"statusLineJson"`
	HooksJSON          string            `json:"hooksJson"`
	HookCommands       map[string]string `json:"hookCommands"`
}

// GetBridgeStatus 返回当前桥接状态(不依赖 live 文件)。
func GetBridgeStatus() BridgeStatus {
	st := BridgeStatus{
		Enabled:   GetSettings().BridgeEnabled,
		Installed: bridgeMjsPath() != "" && slhookExePath() != "",
	}
	if raw, err := os.ReadFile(claudeSettingsPath()); err == nil {
		var cfg map[string]any
		if json.Unmarshal(raw, &cfg) == nil {
			cmd := getStatuslineCommand(cfg)
			st.Hooked = strings.Contains(strings.ToLower(cmd), slhookMarker)
			st.HooksInstalled = true
			for _, event := range lifecycleHookEvents {
				if !hasMonitorHook(event, hookEventGroups(cfg, event)) {
					st.HooksInstalled = false
					break
				}
			}
		}
	}
	st.OrigCmd = readOrigStatusline()
	return st
}

// GetBridgeRules 返回 settings.json 自动检查/自动修复说明弹窗所需的动态配置规则。
func GetBridgeRules() BridgeRules {
	rules := BridgeRules{
		ClaudeSettingsPath: claudeSettingsPath(),
		BackupPath:         origStatuslinePath(),
		HookCommands:       map[string]string{},
	}
	if bridgePath := bridgeMjsPath(); bridgePath != "" {
		rules.StatusLineCommand = `node "` + strings.ReplaceAll(bridgePath, `\`, `/`) + `"`
		rules.StatusLineJSON = `{
  "statusLine": {
    "type": "command",
    "command": "` + rules.StatusLineCommand + `"
  }
}`
	}
	if statuslineOnly, err := json.MarshalIndent(map[string]any{
		"statusLine": map[string]any{"type": "command", "command": rules.StatusLineCommand},
	}, "", "  "); err == nil && rules.StatusLineCommand != "" {
		rules.StatusLineJSON = string(statuslineOnly)
	}
	hooksDoc := map[string]any{}
	for _, event := range lifecycleHookEvents {
		cmd := hookCommand(event)
		if cmd == "" {
			continue
		}
		rules.HookCommands[event] = cmd
		entry := hookEntry(event)
		hooksDoc[event] = []any{entry}
	}
	if len(hooksDoc) > 0 {
		if b, err := json.MarshalIndent(map[string]any{"hooks": hooksDoc}, "", "  "); err == nil {
			rules.HooksJSON = string(b)
		}
	}
	return rules
}
