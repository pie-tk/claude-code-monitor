package monitor

import (
	"fmt"
	"sync"
	"sync/atomic"
)

// TerminalInfo 描述一个内置终端会话，由 ListTerminals 返回给前端。
type TerminalInfo struct {
	ID      string `json:"id"`
	PID     uint32 `json:"pid"`
	Kind    string `json:"kind"`     // claude | pwsh | cmd | shell
	Workdir string `json:"workdir"`
	Live    bool   `json:"live"`
}

// PTYRegistry 管理所有活跃的内置终端会话。线程安全。
//
// ptySession 是平台相关类型（Windows 用 ConPTY，其它平台为存根），
// 由 conpty_windows.go / pty_other.go 各自定义，本文件只持有 *ptySession 指针。
type PTYRegistry struct {
	mu       sync.RWMutex
	sessions map[string]*ptySession
	counter  uint64
}

// NewPTYRegistry 创建空注册表。
func NewPTYRegistry() *PTYRegistry {
	return &PTYRegistry{sessions: make(map[string]*ptySession)}
}

func (r *PTYRegistry) nextID() string {
	return fmt.Sprintf("term-%d", atomic.AddUint64(&r.counter, 1))
}

func (r *PTYRegistry) addSession(s *ptySession) {
	r.mu.Lock()
	r.sessions[s.id] = s
	r.mu.Unlock()
}

func (r *PTYRegistry) session(id string) (*ptySession, bool) {
	r.mu.RLock()
	s, ok := r.sessions[id]
	r.mu.RUnlock()
	return s, ok
}

// Write 把前端键盘输入写给指定终端（xterm.js onData）。
func (r *PTYRegistry) Write(id string, data []byte) error {
	s, ok := r.session(id)
	if !ok {
		return fmt.Errorf("终端会话不存在: %s", id)
	}
	return s.Write(data)
}

// Resize 调整终端尺寸（xterm.js cols/rows 变化）。
func (r *PTYRegistry) Resize(id string, cols, rows int) error {
	s, ok := r.session(id)
	if !ok {
		return fmt.Errorf("终端会话不存在: %s", id)
	}
	return s.Resize(cols, rows)
}

// Kill 终止并清理指定终端（幂等；不存在的 id 静默忽略）。
func (r *PTYRegistry) Kill(id string) {
	s, ok := r.session(id)
	if !ok {
		return
	}
	s.Close()
	r.Remove(id)
}

// Remove 仅从注册表移除（不动进程）。供 outputLoop 的 onExit 回调在子进程自然退出后调用。
func (r *PTYRegistry) Remove(id string) {
	r.mu.Lock()
	delete(r.sessions, id)
	r.mu.Unlock()
}

// List 返回所有终端信息。
func (r *PTYRegistry) List() []TerminalInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]TerminalInfo, 0, len(r.sessions))
	for _, s := range r.sessions {
		out = append(out, s.info())
	}
	return out
}

// CloseAll 终止所有终端（应用退出时调用）。
func (r *PTYRegistry) CloseAll() {
	r.mu.Lock()
	list := make([]*ptySession, 0, len(r.sessions))
	for _, s := range r.sessions {
		list = append(list, s)
	}
	r.sessions = make(map[string]*ptySession)
	r.mu.Unlock()
	for _, s := range list {
		s.Close()
	}
}
