//go:build !windows

package monitor

import (
	"fmt"
	"os"
	"os/exec"
	"sync"

	"github.com/creack/pty"
)

// ptySession 是 unix 平台的内置终端会话：creack/pty 的 master fd + 子进程。
type ptySession struct {
	id      string
	kind    string
	workdir string
	master  *os.File
	cmd     *exec.Cmd
	mu      sync.Mutex
	done    chan struct{}
}

func (s *ptySession) info() TerminalInfo {
	pid := uint32(0)
	if s.cmd != nil && s.cmd.Process != nil {
		pid = uint32(s.cmd.Process.Pid)
	}
	return TerminalInfo{
		ID:      s.id,
		PID:     pid,
		Kind:    s.kind,
		Workdir: s.workdir,
		Live:    true,
	}
}

// ConPTYSupported unix 平台内置终端可用。
func ConPTYSupported() bool { return true }

// StartPTYSession 用 creack/pty 启动子进程，返回 session id。
// cmdline 作为 shell 命令交给 /bin/sh -c 执行（对应 Windows 的 cmd.exe /c 包装）。
func (r *PTYRegistry) StartPTYSession(kind, workdir, cmdline string, cols, rows int,
	onData func(string), onExit func(int)) (string, error) {

	if cmdline == "" {
		return "", fmt.Errorf("命令行为空")
	}
	cmd := exec.Command("/bin/sh", "-c", cmdline)
	cmd.Env = os.Environ()
	if workdir != "" {
		cmd.Dir = workdir
	}

	size := &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)}
	master, err := pty.StartWithSize(cmd, size)
	if err != nil {
		return "", fmt.Errorf("启动 PTY 失败: %w", err)
	}

	s := &ptySession{
		id:      r.nextID(),
		kind:    kind,
		workdir: workdir,
		master:  master,
		cmd:     cmd,
		done:    make(chan struct{}),
	}
	r.addSession(s)

	// 输出读取：阻塞读 master，子进程退出后 EOF 自然结束。
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := master.Read(buf)
			if n > 0 && onData != nil {
				onData(string(buf[:n]))
			}
			if err != nil {
				break
			}
		}
	}()

	// 退出检测：cmd.Wait 返回后 emit exit 并清理。
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			} else {
				code = -1
			}
		}
		close(s.done)
		_ = master.Close()
		if onExit != nil {
			onExit(code)
		}
	}()

	return s.id, nil
}

func (s *ptySession) Write(data []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.master == nil {
		return fmt.Errorf("终端已关闭")
	}
	_, err := s.master.Write(data)
	return err
}

func (s *ptySession) Resize(cols, rows int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.master == nil {
		return nil
	}
	return pty.Setsize(s.master, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

// Close 终止子进程并关闭 master（幂等）。
func (s *ptySession) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
	if s.master != nil {
		_ = s.master.Close()
	}
}
