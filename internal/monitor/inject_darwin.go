//go:build darwin

package monitor

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

func init() {
	Injector = &darwinInjector{}
}

type darwinInjector struct{}

// actionToken 对应前端 buildAskSequence 输出的按键 token（与 inject_windows 一致）。
type actionToken struct {
	Key  string `json:"key,omitempty"`
	Text string `json:"text,omitempty"`
}

// keyTokenBytes 把单个控制键 token 翻译为 PTY 字节序列（unix 终端）。
func keyTokenBytes(key string) (string, bool) {
	switch key {
	case "up":
		return "\x1b[A", true
	case "down":
		return "\x1b[B", true
	case "right":
		return "\x1b[C", true
	case "left":
		return "\x1b[D", true
	case "enter":
		return "\r", true
	case "esc":
		return "\x1b", true
	case "tab":
		return "\t", true
	case "space":
		return " ", true
	case "backspace":
		return "\x7f", true
	case "delete":
		return "\x1b[3~", true
	case "ctrl+a":
		return "\x01", true
	case "ctrl+u":
		return "\x15", true
	case "ctrl+k":
		return "\x0b", true
	case "clearInput":
		return "\x15", true // ctrl+u 清当前行
	}
	return "", false
}

// renderAskTokens 把 token 序列渲染为待写入 PTY 的字节串。
func renderAskTokens(toks []actionToken) (string, error) {
	var sb strings.Builder
	for _, tk := range toks {
		if tk.Text != "" {
			sb.WriteString(tk.Text)
			continue
		}
		b, ok := keyTokenBytes(tk.Key)
		if !ok {
			return "", fmt.Errorf("未知按键 token: %q", tk.Key)
		}
		sb.WriteString(b)
	}
	return sb.String(), nil
}

// writePTY 向 pid 对应的内嵌实例 PTY 写字节。命中内嵌返回 true。
// 直接访问 T5 建立的包级 ptyRegistry 单例：service 创建的内嵌会话注册在同一实例，
// 此处按 pid 反查命中并写入其 PTY master。
func writePTY(pid int, data string) (bool, error) {
	id, ok := ptyRegistry.SessionByPID(uint32(pid))
	if !ok {
		return false, nil // 非内嵌实例
	}
	return true, ptyRegistry.Write(id, []byte(data))
}

func (d *darwinInjector) SendClear(pid int) error {
	if ok, err := writePTY(pid, "/clear\r"); ok {
		return err
	}
	return fmt.Errorf("该实例非内嵌终端，外部终端不支持 clear 注入（建议用内嵌实例）")
}

func (d *darwinInjector) SendRewind(pid int) error {
	// Claude Code（编译二进制）中两次 ESC 等价于回溯（与 Windows 一致）
	if ok, err := writePTY(pid, "\x1b\x1b"); ok {
		return err
	}
	return fmt.Errorf("该实例非内嵌终端，外部终端不支持 rewind 注入")
}

func (d *darwinInjector) SendPrompt(pid int, text string) error {
	if ok, err := writePTY(pid, text); ok {
		if err != nil {
			return err
		}
		time.Sleep(50 * time.Millisecond) // 给 claude（编译二进制）消费文本的时间
		_, err = writePTY(pid, "\r")
		return err
	}
	return fmt.Errorf("该实例非内嵌终端，外部终端不支持 prompt 注入")
}

func (d *darwinInjector) SendAskAnswer(pid int, actions string) error {
	var toks []actionToken
	if err := json.Unmarshal([]byte(actions), &toks); err != nil {
		return fmt.Errorf("actions JSON 解析失败: %w", err)
	}
	// 两段式：先控制键、再文本，避免中文宽字符消费时序问题（与 Windows 经验一致）
	var pending strings.Builder
	flush := func(s string) error {
		if s == "" {
			return nil
		}
		ok, err := writePTY(pid, s)
		if !ok {
			return fmt.Errorf("该实例非内嵌终端，外部终端不支持 ask 注入")
		}
		if err != nil {
			return err
		}
		time.Sleep(50 * time.Millisecond)
		return nil
	}
	for _, tk := range toks {
		if tk.Text != "" {
			if err := flush(pending.String()); err != nil {
				return err
			}
			pending.Reset()
			if err := flush(tk.Text); err != nil {
				return err
			}
			continue
		}
		b, ok := keyTokenBytes(tk.Key)
		if !ok {
			return fmt.Errorf("未知按键 token: %q", tk.Key)
		}
		pending.WriteString(b)
	}
	return flush(pending.String())
}

func (d *darwinInjector) ShowWindow(pid int) error {
	// 内嵌实例：前端通过事件激活 xterm tab（这里无窗口引用，返回 nil 由前端处理）。
	if _, ok := ptyRegistry.SessionByPID(uint32(pid)); ok {
		return nil
	}
	// 外部实例：尽力 activate（见 Task 8 注入 showExternalWindow）
	return showExternalWindow(pid)
}

func (d *darwinInjector) CloseInstance(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("PID 无效")
	}
	if id, ok := ptyRegistry.SessionByPID(uint32(pid)); ok {
		ptyRegistry.Kill(id)
		return fmt.Sprintf("已关闭内嵌实例 PID %d", pid), nil
	}
	// 外部实例：尽力终止进程（见 Task 8）
	return closeExternalInstance(pid)
}

// showExternalWindow 尽力 activate 外部终端窗口（限 Terminal.app / iTerm2）。
// 非保证：若 claude 跑在 VSCode 等内嵌终端，activate 目标不准。
func showExternalWindow(pid int) error {
	// 先尝试 Terminal.app
	if err := exec.Command("osascript", "-e", `tell application "Terminal" to activate`).Run(); err == nil {
		return nil
	}
	// 回退 iTerm2
	if err := exec.Command("osascript", "-e", `tell application "iTerm2" to activate`).Run(); err == nil {
		return nil
	}
	return fmt.Errorf("未找到 Terminal.app/iTerm2 可激活窗口")
}

// closeExternalInstance 尽力终止外部 claude 进程（直接 kill，无法关闭其宿主终端窗口）。
func closeExternalInstance(pid int) (string, error) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return "", fmt.Errorf("PID %d 不存在", pid)
	}
	if err := proc.Kill(); err != nil {
		return "", fmt.Errorf("终止 PID %d 失败: %w", pid, err)
	}
	return fmt.Sprintf("已终止 PID %d（宿主终端窗口需手动关闭）", pid), nil
}
