//go:build darwin

package monitor

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// ResolveClaudePath 查找 claude 可执行文件，排除 Claude Desktop.app。
func ResolveClaudePath() (string, error) {
	if p, err := exec.LookPath("claude"); err == nil {
		if !strings.Contains(strings.ToLower(p), "/applications/claude.app/") {
			return p, nil
		}
	}
	return "", fmt.Errorf("未找到 claude（请确认 Claude Code 已安装且位于 PATH）")
}

// BuildClaudeArgsForPTY 返回启动 claude 时的额外参数（Yolo 模式加 bypassPermissions）。
func BuildClaudeArgsForPTY() string {
	if GetSettings().LaunchYolo {
		return "--permission-mode bypassPermissions"
	}
	return ""
}

// ResolveShellExe 返回用户默认 shell（$SHELL 回退 /bin/zsh）。
func ResolveShellExe() string {
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh
	}
	return "/bin/zsh"
}

// LaunchClaudeInDir 在 Terminal.app 中打开 workdir 并启动 claude。
// mode 仅 "show"/"hide" 影响是否 activate（macOS 无最小化到任务栏概念，hide 仍 activate 但不强制置前）。
func LaunchClaudeInDir(workdir, mode string) (string, error) {
	claude, err := ResolveClaudePath()
	if err != nil {
		return "", err
	}
	args := BuildClaudeArgsForPTY()
	argPart := ""
	if args != "" {
		argPart = " " + args
	}
	// osascript：在新 Terminal 窗口执行 cd + claude。
	// 路径用单引号 shell 转义——避免双引号破坏 AppleScript 的 do script "..." 字符串解析。
	script := fmt.Sprintf(`tell application "Terminal"
	activate
	do script "cd %s && %s%s"
end tell`, shellEscape(workdir), shellEscape(claude), argPart)
	cmd := exec.Command("osascript", "-e", script)
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("启动 Terminal 失败: %w", err)
	}
	_ = mode // show/hide 在 macOS 均走 activate（Terminal 无可靠最小化语义）
	return "terminal", nil
}

// shellEscape 用单引号包裹路径用于 shell（内嵌单引号用 '\'' 转义）。
// 选单引号而非双引号：单引号串内无特殊字符需转义，且不含双引号字符，
// 可安全嵌入 AppleScript 的双引号字符串字面量。
func shellEscape(p string) string {
	return "'" + strings.ReplaceAll(p, "'", `'\''`) + "'"
}
