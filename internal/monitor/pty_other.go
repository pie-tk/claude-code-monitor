//go:build !windows

package monitor

import "fmt"

// ptySession 非 Windows 平台存根（永不实例化，仅为编译通过）。
type ptySession struct {
	id      string
	kind    string
	workdir string
}

func (s *ptySession) Write([]byte) error    { return nil }
func (s *ptySession) Resize(int, int) error { return nil }
func (s *ptySession) Close()                {}
func (s *ptySession) info() TerminalInfo    { return TerminalInfo{} }

// ConPTYSupported 非 Windows 永远 false。
func ConPTYSupported() bool { return false }

// StartPTYSession 非 Windows 存根。
func (r *PTYRegistry) StartPTYSession(kind, workdir, cmdline string, cols, rows int,
	onData func(string), onExit func(int)) (string, error) {
	return "", fmt.Errorf("当前平台暂不支持内置终端")
}
