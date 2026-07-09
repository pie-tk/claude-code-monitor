//go:build !windows

package monitor

import (
	"fmt"
	"os/exec"
	"runtime"
)

// OpenInBrowser 在系统默认浏览器中打开 URL。
func OpenInBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		// macOS: open
		if err := exec.Command("open", url).Start(); err != nil {
			return fmt.Errorf("打开浏览器失败: %w", err)
		}
		return nil
	default:
		// Linux: xdg-open（含 WSL 分支）
		var cmd string
		args := []string{url}
		if isWSL() {
			cmd = "cmd.exe"
			args = []string{"/c", "start", url}
		} else {
			cmd = "xdg-open"
		}
		if err := exec.Command(cmd, args...).Start(); err != nil {
			return fmt.Errorf("打开浏览器失败: %w", err)
		}
		return nil
	}
}

func isWSL() bool {
	_, err := exec.LookPath("cmd.exe")
	return err == nil
}
