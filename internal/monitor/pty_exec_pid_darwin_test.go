//go:build darwin

package monitor

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestStartPTYSessionExecRegistersCommandPID 验证内嵌注入的 pid 一致性（修复「mac 内嵌
// claude 无法发送」的关键机制）：
//   - cmdline 以 exec 开头时，StartPTYSession 注册的 pid == 命令进程自己的 pid（exec
//     替换 /bin/sh，pid 不变），SessionByPID 命中、writePTY 注入成功。
//   - 对照 bug：cmdline 无 exec 时注册的是 /bin/sh 包装层 pid（≠ claude pid），按 claude
//     pid 注入永不命中。
func TestStartPTYSessionExecRegistersCommandPID(t *testing.T) {
	// 用包级单例（GetPTYRegistry）：inject 层的 writePTY 硬编码访问包级 ptyRegistry，
	// 测试必须与其同一实例才能验证注入命中（service 层 NewMonitorService 也用此单例）。
	r := GetPTYRegistry()
	pidFile := filepath.Join(t.TempDir(), "pid")
	// exec 让内层 sh 替换外层 sh、pid 不变（模拟修复后 "exec claude" 的 pid 行为）。
	cmdline := "exec /bin/sh -c 'echo $$ > " + pidFile + "; sleep 5'"
	sid, err := r.StartPTYSession("test", "", cmdline, 80, 24, nil, nil)
	if err != nil {
		t.Fatalf("StartPTYSession: %v", err)
	}
	defer r.Kill(sid)

	// 命令把自己的 pid 写到文件，轮询读出（即「claude 的真实 pid」）。
	var cmdPID uint32
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if data, rerr := os.ReadFile(pidFile); rerr == nil {
			if p, perr := strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32); perr == nil && p > 0 {
				cmdPID = uint32(p)
				break
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	if cmdPID == 0 {
		t.Fatal("命令未在超时内写出 pid")
	}

	// exec 后注册 pid 应 == 命令 pid → SessionByPID 命中。
	gotSid, ok := r.SessionByPID(cmdPID)
	if !ok {
		t.Fatalf("SessionByPID(%d) 未命中：exec 后注册 pid 应等于命令 pid（注入 bug 根因即不命中）", cmdPID)
	}
	if gotSid != sid {
		t.Fatalf("命中错误 session: got=%s want=%s", gotSid, sid)
	}

	// 反向：writePTY 用命令 pid 能命中（注入链路通）。
	if hit, _ := writePTY(int(cmdPID), ""); !hit {
		t.Fatal("writePTY 返回 hit=false，命令 pid 仍被当作非内嵌实例")
	}
}
