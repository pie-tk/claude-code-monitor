//go:build darwin

package monitor

import "testing"

func TestParsePsLineMatchesClaudeNode(t *testing.T) {
	cases := []struct {
		line  string
		match bool
	}{
		{"12345 node /Users/x/.nvm/versions/node/v25/bin/node /Users/x/.nvm/.../claude/cli.js", true},
		{"12345 /usr/local/bin/node /path/to/claude", true},
		{"12346 /Applications/Claude.app/Contents/MacOS/Claude", false}, // 排除 Desktop
		{"12347 /bin/zsh", false},                                      // 非 claude
		{"12348 node /path/to/something/else", false},                  // node 但非 claude
	}
	for _, c := range cases {
		got := isClaudeCmdline(c.line)
		if got != c.match {
			t.Errorf("isClaudeCmdline(%q)=%v want %v", c.line, got, c.match)
		}
	}
}

func TestIsClaudeCmdlineCaseInsensitive(t *testing.T) {
	if !isClaudeCmdline("1 node /x/Claude/cli.js") {
		t.Fatal("应大小写不敏感匹配 claude")
	}
}

// TestIsClaudeCmdlineCompiledBinary 覆盖实测形态：claude CLI 是 Mach-O 编译二进制，
// ps 直接显示 argv[0]=claude（无 node 前缀）。同时验证 MCP server / shell wrapper
// 等命令行含 "claude" 子串但非 claude 本体的进程被正确排除。
func TestIsClaudeCmdlineCompiledBinary(t *testing.T) {
	cases := []struct {
		line  string
		match bool
	}{
		{"claude --dangerously-skip-permissions", true},                       // 编译二进制形态
		{"claude --dangerously-skip-permissions -c", true},                    // 带 -c 续会话
		{"/Users/x/.nvm/versions/node/v25/bin/claude --dangerously-skip-permissions", true}, // 全路径 argv0
		{"/Users/x/.pencil/mcp/cursor/out/mcp-server-darwin-arm64 --app cursor --agent claudeCodeCLI", false}, // MCP server 含 claude 子串
		{"/bin/zsh -c echo claude", false},                                    // shell wrapper
	}
	for _, c := range cases {
		got := isClaudeCmdline(c.line)
		if got != c.match {
			t.Errorf("isClaudeCmdline(%q)=%v want %v", c.line, got, c.match)
		}
	}
}
