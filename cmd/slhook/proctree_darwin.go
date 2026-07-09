//go:build darwin

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
)

// findClaudePID 从自身进程起沿父进程链向上查找「跑 claude 的进程（编译二进制或 node 脚本形态）」，
// 返回其 pid。链路：claude → statusline: node bridge.mjs → cc-console-sl(本进程)。
// 向上最多追溯 8 级。未找到返回 0。
func findClaudePID() int {
	pid := os.Getpid()
	for range 8 {
		ppid := parentPID(pid)
		if ppid <= 1 {
			break
		}
		if cmd := psCommand(ppid); isClaudeCommand(cmd) {
			return ppid
		}
		pid = ppid
	}
	return 0
}

// isClaudeCommand 判断一行 ps 命令行是否为 claude CLI 进程。大小写不敏感。
//
// 实测 macOS 上 claude CLI 是 Mach-O 编译二进制：命令行形如 "claude --dangerously-skip-permissions"，
// argv[0]=claude，不含 node。故匹配规则须兼容两种形态：
//  1. 编译二进制形态：首 token（argv[0]）basename 为 "claude"
//  2. node 脚本形态（legacy/其他分发）：命令行含 node 且含 claude
//
// 始终排除 /Applications/Claude.app（Electron Desktop，命令行不同）。
func isClaudeCommand(cmd string) bool {
	low := strings.ToLower(cmd)
	if !strings.Contains(low, "claude") {
		return false
	}
	if strings.Contains(low, "/applications/claude.app/") {
		return false
	}
	if hasClaudeBinaryArgv0(cmd) {
		return true
	}
	return strings.Contains(low, "node")
}

// hasClaudeBinaryArgv0 判断命令行首个程序 token（跳过可能的前导纯数字 PID）的 basename
// 是否为 claude/claude.exe。psCommand 用 `ps -o command=` 输出无 PID 前缀，argv[0] 即首 token；
// 跳 PID 逻辑保留以兼容带 PID 前缀的测试用例。
func hasClaudeBinaryArgv0(line string) bool {
	fields := strings.Fields(line)
	for i := 0; i < 2 && i < len(fields); i++ {
		if _, err := strconv.Atoi(fields[i]); err == nil {
			continue // 跳过前导 PID
		}
		base := fields[i]
		if j := strings.LastIndex(base, "/"); j >= 0 {
			base = base[j+1:]
		}
		base = strings.TrimSuffix(base, ".exe")
		return strings.ToLower(base) == "claude"
	}
	return false
}

// parentPID 返回 pid 的父 pid，失败返回 0。
func parentPID(pid int) int {
	out, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	p, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0
	}
	return p
}

// psCommand 返回 pid 的完整命令行，失败返回 ""。
func psCommand(pid int) string {
	out, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
