//go:build darwin

package monitor

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func init() {
	isProcessAlive = darwinIsProcessAlive
	enumerateClaude = darwinEnumerateClaude
	procCwd = darwinProcCwd
	enumerateChildren = darwinEnumerateChildren
}

// isClaudeCmdline 判断一行 ps 命令行是否为 claude CLI 进程。大小写不敏感。
//
// 实测 macOS 上 claude CLI（@anthropic-ai/claude-code）是 Mach-O 编译二进制：nvm
// ~/.nvm/.../bin/claude 是符号链接 → 包内 claude.exe（arm64 编译产物，非 node 脚本）。
// ps -o command= 直接显示 argv[0]=claude（如 "claude --dangerously-skip-permissions"），
// 命令行不含 node。因此匹配规则须兼容两种形态：
//  1. 编译二进制形态：首 token（argv[0]）basename 为 "claude"
//  2. node 脚本形态（legacy/其他分发）：命令行含 node 且含 claude
//
// 始终排除 /Applications/Claude.app（Electron Desktop，命令行不同）。
func isClaudeCmdline(line string) bool {
	low := strings.ToLower(line)
	if !strings.Contains(low, "claude") {
		return false
	}
	if strings.Contains(low, "/applications/claude.app/") {
		return false
	}
	if strings.Contains(low, "bridge.mjs") {
		return false // statusline 的 node bridge.mjs 层, 路径可能含 claude(如 ~/.claude/...), 须排除
	}
	if hasClaudeBinaryArgv0(line) {
		return true
	}
	return strings.Contains(low, "node")
}

// hasClaudeBinaryArgv0 判断命令行首个程序 token（跳过可能的前导纯数字 PID）的 basename
// 是否为 claude/claude.exe。darwinEnumerateClaude 调用前已剥离 PID，故 argv[0] 即首 token；
// 兼容测试用例带 PID 前缀的情况。
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

// darwinEnumerateClaude 用 ps -ax 枚举所有进程命令行，筛出 claude(node)。
func darwinEnumerateClaude() []claudeProc {
	out, err := exec.Command("ps", "-ax", "-o", "pid=,command=").Output()
	if err != nil {
		return nil
	}
	var procs []claudeProc
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// 格式："PID COMMAND..."（PID 与命令间多空格）
		sp := strings.SplitN(line, " ", 2)
		if len(sp) < 2 {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(sp[0]))
		if err != nil || pid <= 0 {
			continue
		}
		cmd := strings.TrimSpace(sp[1])
		if !isClaudeCmdline(cmd) {
			continue
		}
		procs = append(procs, claudeProc{pid: pid, createMs: darwinProcCreateMs(pid)})
	}
	return procs
}

// darwinProcCwd 用 lsof 读 pid 的 cwd。
func darwinProcCwd(pid int) string {
	out, err := exec.Command("lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		// lsof -n 输出 cwd 行形如 "n/Users/x/project"
		if strings.HasPrefix(line, "n") {
			return strings.TrimPrefix(line, "n")
		}
	}
	return ""
}

// darwinIsProcessAlive 检查 pid 存在且启动时间与 startedAt 匹配（容差 15s，防 pid 复用）。
func darwinIsProcessAlive(pid int, startedAt int64) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// signal 0 探活
	if err := proc.Signal(syscall.Signal(0)); err != nil {
		return false
	}
	if startedAt == 0 {
		return true
	}
	createMs := darwinProcCreateMs(pid)
	if createMs == 0 {
		return true // 取不到时间则只信存活
	}
	diff := createMs - startedAt
	if diff < 0 {
		diff = -diff
	}
	return diff <= 15000
}

// darwinProcCreateMs 用 ps -o lstart= 解析 pid 启动时间为 epoch 毫秒。失败返回 0。
func darwinProcCreateMs(pid int) int64 {
	out, err := exec.Command("ps", "-o", "lstart=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return 0
	}
	// lstart 格式："Mon Jan  2 15:04:05 2026"
	t, err := time.Parse("Mon Jan _2 15:04:05 2006", s)
	if err != nil {
		// 回退：尝试不带前导空格占位的格式
		t, err = time.Parse("Mon Jan 2 15:04:05 2006", s)
		if err != nil {
			return 0
		}
	}
	return t.UnixMilli()
}

// darwinEnumerateChildren 用 pgrep -P 枚举每个 claude pid 的直接子进程。
func darwinEnumerateChildren(claudePids []int) map[int][]int {
	out := make(map[int][]int, len(claudePids))
	for _, p := range claudePids {
		raw, err := exec.Command("pgrep", "-P", strconv.Itoa(p)).Output()
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(raw), "\n") {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}
			if child, err := strconv.Atoi(line); err == nil {
				out[p] = append(out[p], child)
			}
		}
	}
	return out
}
