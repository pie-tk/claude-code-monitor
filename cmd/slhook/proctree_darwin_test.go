//go:build darwin

package main

import "testing"

func TestIsClaudeCommand(t *testing.T) {
	cases := []struct{ cmd string; want bool }{
		// 编译二进制形态（macOS 新版 claude 实测）
		{"claude --dangerously-skip-permissions", true},
		{"claude", true},
		{"/Users/x/.nvm/versions/node/v25.4.0/bin/claude --dangerously-skip-permissions", true},
		{"claude.exe --foo", true},
		// node 脚本形态（legacy/其他分发）
		{"node /x/.nvm/.../claude/cli.js", true},
		{"node /x/claude", true},
		// 排除 Desktop App
		{"/Applications/Claude.app/Contents/MacOS/Claude", false},
		// 无关进程
		{"/bin/zsh", false},
		{"node /x/server.js", false},
		{"git status", false},
		// statusline 的 node bridge.mjs 层：路径含 claude（如 ~/.claude/...），须排除
		{"node /Users/x/.nvm/.../bin/node \"/Users/x/.claude/cc-console/bridge.mjs\"", false},
	}
	for _, c := range cases {
		if got := isClaudeCommand(c.cmd); got != c.want {
			t.Errorf("isClaudeCommand(%q)=%v want %v", c.cmd, got, c.want)
		}
	}
}
