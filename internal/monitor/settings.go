package monitor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sync"
)

// Settings 持久化到 ~/.cc-console.json 的应用设置。
type Settings struct {
	ModelLimits              map[string]int64 `json:"modelLimits"`
	CloseQuits               bool             `json:"closeQuits"`
	AutoStart                bool             `json:"autoStart"`
	BridgeEnabled            bool             `json:"bridgeEnabled"`            // statusline 桥接（默认启用）
	AutoCheckClaudeSettings  bool             `json:"autoCheckClaudeSettings"`  // 每 10 秒检查 ~/.claude/settings.json 是否仍满足监控器要求
	AutoRepairClaudeSettings bool             `json:"autoRepairClaudeSettings"` // 检测到漂移后是否自动修复 ~/.claude/settings.json
	RecentDirs               []string         `json:"recentDirs"`               // 最近工作目录（≤8，最近在前）
	LaunchWindowMode         string           `json:"launchWindowMode"`         // 启动终端模式: embedded 应用内置终端 / show 显示外部窗口 / hide 最小化到任务栏
	EnterToSend              bool             `json:"enterToSend"`              // 回车直接发送（默认 true）；false 时 Shift+Enter 发送
	LaunchYolo               bool             `json:"launchYolo"`               // 新建实例时使用 bypassPermissions 模式（默认 true）
	WindowWidth              int              `json:"windowWidth"`              // 主窗口宽度（启动恢复用）
	WindowHeight             int              `json:"windowHeight"`             // 主窗口高度（启动恢复用）
	WindowMaximised          bool             `json:"windowMaximised"`          // 主窗口上次是否最大化
	SortField                string           `json:"sortField"`                // 实例列表排序字段：updatedAt | startedAt | contextTokens
	SortDir                  string           `json:"sortDir"`                  // 排序方向：asc | desc
	ViewMode                 string           `json:"viewMode"`                 // 主区布局：list(实例卡片列表) | chat(左会话标签 + 右对话，默认)
	ShowSessionSubtitle      bool             `json:"showSessionSubtitle"`      // chat 布局会话标签是否显示目录副标题（默认 true）
}

var currentSettings Settings

// settingsMu 保护 currentSettings 的并发读写（resize 防抖 goroutine 与前端设置面板可能同时访问）。
var settingsMu sync.RWMutex

func configPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", err
	}
	return filepath.Join(home, ".cc-console.json"), nil
}

// LoadSettings 从磁盘加载设置，首次运行返回默认值。
func LoadSettings() error {
	currentSettings = Settings{
		ModelLimits:              map[string]int64{},
		BridgeEnabled:            true,        // 默认启用 statusline 桥接
		AutoCheckClaudeSettings:  true,        // 默认启用 settings.json 健康检查
		AutoRepairClaudeSettings: true,        // 默认启用 settings.json 自动修复
		LaunchWindowMode:         defaultLaunchMode(), // mac 默认内嵌终端（外部窗口实例无法注入/交互）；Windows 默认最小化外部窗口
		EnterToSend:              true,        // 默认回车直接发送（Shift+Enter 换行）
		LaunchYolo:               true,        // 默认 yolo 模式（跳过权限确认）
		SortField:                "updatedAt", // 默认按最后活动排序
		SortDir:                  "desc",      // 默认降序（最新在前）
		ViewMode:                 "chat",      // 默认会话布局（左会话标签 + 右对话）
		ShowSessionSubtitle:      true,        // 默认显示会话目录副标题
	}

	// 清理改名前（v1.3.9 之前）残留的旧注册表自启项；与配置文件无关，每次启动幂等执行。
	cleanupLegacyAutoStart()

	path, err := configPath()
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil // 文件不存在 → 用默认值
	}
	json.Unmarshal(data, &currentSettings)
	// 迁移：mac 上外部窗口(hide)实例无法注入/交互，等于丢失核心能力。历史配置（或从 Windows
	// 拷贝来的配置）若残留 hide，强制校正为 embedded；仅校正内存值，用户下次保存设置时自然落盘。
	if runtime.GOOS == "darwin" && currentSettings.LaunchWindowMode == "hide" {
		currentSettings.LaunchWindowMode = defaultLaunchMode()
	}
	return nil
}

// defaultLaunchMode 返回启动模式的平台默认值。
// mac 只有「应用内置终端」支持输入注入与在 cc-console 内交互；外部窗口（Terminal.app）实例
// 无法注入，等于丢失工具核心能力，故默认 embedded。Windows 默认 hide（最小化外部窗口，不抢焦点）。
func defaultLaunchMode() string {
	if runtime.GOOS == "darwin" {
		return "embedded"
	}
	return "hide"
}

// writeSettingsToDisk 把设置序列化写回 ~/.cc-console.json。
func writeSettingsToDisk(s Settings) error {
	path, err := configPath()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// SaveSettings 将设置写回磁盘。
func SaveSettings(s Settings) error {
	settingsMu.Lock()
	currentSettings = s
	settingsMu.Unlock()
	return writeSettingsToDisk(s)
}

// GetSettings 返回当前设置的快照（线程安全）。
func GetSettings() Settings {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	return currentSettings
}

// IsCloseQuit 返回关闭按钮是否应直接退出。
func IsCloseQuit() bool {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	return currentSettings.CloseQuits
}

// WindowGeometry 已保存的主窗口几何（宽/高/是否最大化）。Ok=false 表示无有效记录。
type WindowGeometry struct {
	Width     int
	Height    int
	Maximised bool
	Ok        bool
}

// 与主窗口 MinWidth/MinHeight 一致，用于校验保存的几何是否有效（防旧数据/损坏值）。
const minWindowWidth, minWindowHeight = 660, 420

// GetWindowGeometry 读取已保存的主窗口几何，供启动时恢复窗口大小。
func GetWindowGeometry() WindowGeometry {
	settingsMu.RLock()
	defer settingsMu.RUnlock()
	if currentSettings.WindowWidth >= minWindowWidth && currentSettings.WindowHeight >= minWindowHeight {
		return WindowGeometry{
			Width:     currentSettings.WindowWidth,
			Height:    currentSettings.WindowHeight,
			Maximised: currentSettings.WindowMaximised,
			Ok:        true,
		}
	}
	return WindowGeometry{}
}

// UpdateWindowGeometry 更新主窗口几何并写盘（窗口缩放后由防抖定时器调用）。
func UpdateWindowGeometry(width, height int, maximised bool) {
	settingsMu.Lock()
	currentSettings.WindowWidth = width
	currentSettings.WindowHeight = height
	currentSettings.WindowMaximised = maximised
	s := currentSettings
	settingsMu.Unlock()
	_ = writeSettingsToDisk(s)
}
