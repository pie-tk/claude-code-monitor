package monitor

// ConsoleInput 抽象平台特定的控制台输入注入。
type ConsoleInput interface {
	// SendClear 向目标实例发送 /clear 命令。
	SendClear(pid int) error
	// SendRewind 向目标实例发送 ESC×2（回溯）。
	SendRewind(pid int) error
	// SendPrompt 向目标实例发送文本并回车。
	SendPrompt(pid int, text string) error
	// SendAskAnswer 向目标实例发送按键 token 序列（AskUserQuestion 作答）。
	// actions 是 token 的 JSON 字符串，每个 token 为 {"key":"left|right|up|down|space|tab|enter|backspace|delete|esc|ctrl+a|ctrl+u|ctrl+k|clearInput"}
	// 或 {"text":"abc"}（注入文本）。ctrl+u/ctrl+k 用于清空 Type something 当前行残留内容。供前端驱动终端的方向键/空格/回车选择 UI。
	SendAskAnswer(pid int, actions string) error
	// ShowWindow 将目标实例所在的终端窗口置前。
	ShowWindow(pid int) error
	// CloseInstance 关闭目标 Claude Code 进程，并尽量关闭其独立终端窗口。
	CloseInstance(pid int) (string, error)
}

// Injector 是当前平台的控制台注入实现，由各平台的 inject_*.go 在 init() 中设置。
var Injector ConsoleInput
