//go:build windows

package monitor

import (
	"strings"
	"testing"
	"time"
)

// TestConPTYInteractive 端到端验证 ConPTY 交互流程：起 cmd /k（常驻），
// 写入 echo 命令，等待标记出现在输出里。覆盖 CreatePseudoConsole + STARTUPINFOEX
// 属性表 + CreateProcess + outputLoop 轮询读 + Write + Resize + Kill 全链路。
//
// 不用 `cmd /c echo`：ConPTY 对「极快退出」的命令会丢失输出（conhost 来不及刷盘），
// 不能稳定反映读链路是否正常。交互式 cmd /k 才贴近真实 claude 用法。
func TestConPTYInteractive(t *testing.T) {
	if !ConPTYSupported() {
		t.Skip("ConPTY 不可用（Win10 < 1809）")
	}

	r := NewPTYRegistry()
	var got strings.Builder
	sid, err := r.StartPTYSession("cmd", "", `cmd.exe /K`, 80, 24,
		func(data string) { got.WriteString(data) },
		func(code int) {},
	)
	if err != nil {
		t.Fatalf("StartPTYSession 失败: %v", err)
	}
	defer r.Kill(sid)

	// 等 cmd 启动并打印 prompt
	time.Sleep(500 * time.Millisecond)

	if err := r.Resize(sid, 120, 30); err != nil {
		t.Errorf("Resize 失败: %v", err)
	}
	if err := r.Write(sid, []byte("echo conpty_marker_42\r\n")); err != nil {
		t.Fatalf("Write 失败: %v", err)
	}

	// 等标记出现（cmd 回显 + echo 输出会各出现一次）
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(got.String(), "conpty_marker_42") {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !strings.Contains(got.String(), "conpty_marker_42") {
		t.Errorf("输出未包含 echo 标记，got: %q", got.String())
	}
}

// TestConPTYKill 确认 Kill 不会死锁、子进程被终止（关 tab 路径）。
func TestConPTYKill(t *testing.T) {
	if !ConPTYSupported() {
		t.Skip("ConPTY 不可用")
	}
	r := NewPTYRegistry()
	sid, err := r.StartPTYSession("cmd", "", `cmd.exe /K`, 80, 24,
		func(data string) {}, func(code int) {})
	if err != nil {
		t.Fatalf("StartPTYSession 失败: %v", err)
	}
	done := make(chan struct{})
	go func() { r.Kill(sid); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Kill 超时（可能死锁）")
	}
}
