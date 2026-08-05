//go:build !windows

package monitor

import (
	"os/exec"
	"strconv"
	"strings"
)

func init() {
	// 非 Windows:用 ps 读取进程命令行（macOS/Linux 兼容）。
	processCmdline = func(pid int) string {
		out, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
		if err != nil {
			return ""
		}
		return strings.ToLower(strings.TrimSpace(string(out)))
	}
}
