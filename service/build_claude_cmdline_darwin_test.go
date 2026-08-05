//go:build darwin

package service

import (
	"strings"
	"testing"
)

// TestBuildClaudeCmdlineDarwinUsesExec 验证 mac 内嵌 claude 的命令行以 exec 开头。
//
// 背景（bug）：StartPTYSession 用 /bin/sh -c <cmdline> 启动内嵌终端；若 cmdline 为
// "/path/to/claude"（无 exec），sh 会 fork claude，PTY 注册的 pid 是 sh（父进程）而非
// claude（子进程）。而注入（SendPrompt/Clear/Rewind/Ask）按 detector 检测到的 claude pid
// 查 SessionByPID → 永不命中 → writePTY 返回 (false,nil) → 所有内嵌实例注入失败，
// 报「该实例非内嵌终端」。用 exec 让 claude 替换 sh、pid 与 claude 一致，注入才能命中。
func TestBuildClaudeCmdlineDarwinUsesExec(t *testing.T) {
	cmdline, err := buildClaudeCmdline()
	if err != nil {
		t.Skipf("claude 未安装，跳过：%v", err)
	}
	if !strings.HasPrefix(cmdline, "exec ") {
		t.Fatalf("darwin 下 buildClaudeCmdline 须以 'exec ' 开头（让 claude 替换 /bin/sh，"+
			"注册 pid 与 claude 一致）；当前无 exec 会注册 sh pid 导致内嵌注入全失败。got: %q", cmdline)
	}
}
