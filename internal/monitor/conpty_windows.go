//go:build windows

package monitor

import (
	"fmt"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"cc-console/internal/crashlog"
	"golang.org/x/sys/windows"
)

// ConPTY 伪控制台标志：继承光标位置，避免 claude TUI 光标定位错乱。
const pseudoconsoleInheritCursor uint32 = 0x1

// STILL_ACTIVE：GetExitCodeProcess 返回此值表示进程尚未退出。
const stillActive uint32 = 259

// ptySession 是单个内置终端会话的状态（Windows ConPTY 实现）。
//
// 生命周期：startConPty 创建 → outputLoop goroutine 读输出 + wait goroutine 等进程退出
// → 任一退出路径触发 cleanup 释放资源。
//
// 重要：ConPTY 的输出管道由 conhost 持有，子进程退出时管道【不会】EOF，
// 因此不能靠 ReadFile EOF 检测退出——必须用 WaitForSingleObject(hProc) 单独监听进程句柄。
type ptySession struct {
	id      string // 会话 id（registry 分配，形如 term-N）
	kind    string // claude | pwsh | cmd | shell
	workdir string
	pid     uint32

	hPC       windows.Handle // HPCON 伪控制台
	hInWrite  windows.Handle // 父进程写入端（前端键盘输入 → 子进程 stdin）
	hOutRead  windows.Handle // 父进程读取端（子进程 stdout → 前端渲染）
	hInRead   windows.Handle // ConPTY 输入读端（CreatePseudoConsole 用，保留到 cleanup）
	hOutWrite windows.Handle // ConPTY 输出写端（CreatePseudoConsole 用，保留到 cleanup）
	hProc     windows.Handle // 子进程主句柄

	writeMu sync.Mutex    // 串行 WriteFile（xterm.js onData 高频小包）
	stop    chan struct{} // close(stop) 通知 outputLoop 轮询循环退出
	stopped chan struct{} // outputLoop 退出后 close，供 cleanup 等待
	cleaned chan struct{} // cleanup 完成后 close，供 Close 等待
	once    sync.Once     // cleanup 幂等
}

// PeekNamedPipe 不在 golang.org/x/sys/windows 中，这里手动声明。
// 仅用于探测输出管道是否有可读数据（轮询模型，避免同步 ReadFile 无法被打断的问题）。
var procPeekNamedPipe = windows.NewLazySystemDLL("kernel32.dll").NewProc("PeekNamedPipe")

func peekNamedPipeAvail(h windows.Handle) (uint32, error) {
	var avail uint32
	r1, _, e1 := syscall.Syscall6(procPeekNamedPipe.Addr(), 6,
		uintptr(h), 0, 0, 0, uintptr(unsafe.Pointer(&avail)), 0)
	if r1 == 0 {
		if e1 != 0 {
			return 0, e1
		}
		return 0, syscall.EINVAL
	}
	return avail, nil
}

// CreateEnvironmentBlock / DestroyEnvironmentBlock 在 userenv.dll，x/sys 未导出，手动声明。
// 用于给 ConPTY 子进程构造「干净的 Windows 环境」（按用户 profile 重建，不继承本进程可能被污染的 env，
// 如从 MSYS bash 启动时 HOME=/c/Users/... 会让 claude 找不到 ~/.claude）。
var (
	userenv                     = windows.NewLazySystemDLL("userenv.dll")
	procCreateEnvironmentBlock  = userenv.NewProc("CreateEnvironmentBlock")
	procDestroyEnvironmentBlock = userenv.NewProc("DestroyEnvironmentBlock")
)

// createCleanEnvBlock 返回按当前用户 profile 重建的环境块（bInherit=FALSE，不含本进程变量）。
// 失败返回 0（调用方回退为 nil，由 CreateProcess 继承父进程 env）。
func createCleanEnvBlock() windows.Handle {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &token); err != nil {
		return 0
	}
	defer token.Close()
	var block uintptr
	// hToken=当前用户 token, bInherit=FALSE → 仅用户 profile 变量（USERPROFILE/APPDATA/PATH 等），
	// 不继承本进程的 HOME 等。
	r, _, _ := procCreateEnvironmentBlock.Call(uintptr(unsafe.Pointer(&block)), uintptr(token), 0)
	if r == 0 || block == 0 {
		return 0
	}
	return windows.Handle(block)
}

func destroyEnvBlock(h windows.Handle) {
	if h != 0 {
		procDestroyEnvironmentBlock.Call(uintptr(h))
	}
}

// CleanEnvSlice 返回按当前用户 profile 重建的环境变量切片（"KEY=VALUE"），
// 供外部终端启动（exec.Command）使用——避免继承本进程被污染的 env（如 MSYS bash 的 HOME=/c/...）。
// 失败返回 nil（调用方回退为继承父进程 env）。
func CleanEnvSlice() []string {
	block := createCleanEnvBlock()
	if block == 0 {
		return nil
	}
	defer destroyEnvBlock(block)
	var out []string
	p := uintptr(block)
	for {
		// 收集一个 UTF-16 字符串直到 \0
		var chars []uint16
		q := p
		for {
			c := *(*uint16)(unsafe.Pointer(q))
			if c == 0 {
				break
			}
			chars = append(chars, c)
			q += 2
		}
		if len(chars) == 0 {
			break // 双 null → 环境块结束
		}
		out = append(out, string(utf16.Decode(chars)))
		p = q + 2 // 跳过本串的 \0，进入下一项
	}
	return out
}

// ConPTYSupported 探测当前系统是否支持 ConPTY（Win10 1809+）。
// 实测一次缓存：CreatePseudoConsole 符号在老系统缺失时返回 error，不会 panic。
func ConPTYSupported() bool {
	conptyOnce.Do(func() {
		defer func() { _ = recover() }()
		sa := &windows.SecurityAttributes{
			Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
			InheritHandle: 1,
		}
		var inR, inW, outR, outW windows.Handle
		if windows.CreatePipe(&inR, &inW, sa, 0) != nil {
			return
		}
		if windows.CreatePipe(&outR, &outW, sa, 0) != nil {
			_ = windows.CloseHandle(inR)
			_ = windows.CloseHandle(inW)
			return
		}
		var hPC windows.Handle
		err := windows.CreatePseudoConsole(windows.Coord{X: 1, Y: 1}, inR, outW, 0, &hPC)
		_ = windows.CloseHandle(inR)
		_ = windows.CloseHandle(inW)
		_ = windows.CloseHandle(outR)
		_ = windows.CloseHandle(outW)
		if err != nil {
			return
		}
		windows.ClosePseudoConsole(hPC)
		conptyAvail = true
	})
	return conptyAvail
}

var (
	conptyOnce  sync.Once
	conptyAvail bool
)

// StartPTYSession 创建并启动一个 PTY 会话（Windows 实现）。
// onData 收到 UTF-8 输出片段；onExit 在子进程退出（自然退出或被 Kill）时回调一次。
func (r *PTYRegistry) StartPTYSession(kind, workdir, cmdline string, cols, rows int,
	onData func(string), onExit func(int)) (string, error) {
	if !ConPTYSupported() {
		return "", fmt.Errorf("ConPTY 不可用（需要 Windows 10 1809+），请在设置中改用外部窗口")
	}
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}
	s, err := startConPty(cmdline, workdir, cols, rows)
	if err != nil {
		return "", err
	}
	s.kind = kind
	s.workdir = workdir
	s.id = r.nextID()
	r.addSession(s)
	go s.outputLoop(onData)
	// wait goroutine：等子进程退出（自然退出或被 Kill）→ 触发 onExit + cleanup。
	// 必须用进程句柄等待，不能靠输出管道 EOF（conhost 持有管道，子进程退出时不会 EOF）。
	go func() {
		defer crashlog.Recover()
		_, _ = windows.WaitForSingleObject(s.hProc, windows.INFINITE)
		code := s.exitCode()
		// 进程已退出，但管道里可能仍有 conhost 缓冲的尾部输出未读。
		// 短暂等待让 outputLoop 把残留数据读出来，再关 hOutRead（关闭会丢弃未读内容）。
		time.Sleep(150 * time.Millisecond)
		if onExit != nil {
			onExit(code)
		}
		s.cleanup()
	}()
	return s.id, nil
}

// startConPty 创建伪控制台并启动子进程。
//   - cmdline 为完整命令行（可执行路径用双引号包裹，含空格也安全）。
//   - workdir 为空表示继承父进程当前目录。
//
// 返回的 ptySession 已就绪，调用方负责 go s.outputLoop(...) 启动读循环。
func startConPty(cmdline, workdir string, cols, rows int) (*ptySession, error) {
	cmdline16, err := windows.UTF16PtrFromString(cmdline)
	if err != nil {
		return nil, fmt.Errorf("命令行编码失败: %w", err)
	}
	var workdir16 *uint16
	if workdir != "" {
		workdir16, err = windows.UTF16PtrFromString(workdir)
		if err != nil {
			return nil, fmt.Errorf("工作目录编码失败: %w", err)
		}
	}

	// 两条管道：stdin / stdout。stderr 由 ConPTY 复用 stdout，无需单独管道。
	sa := &windows.SecurityAttributes{
		Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		InheritHandle: 1,
	}
	var hInRead, hInWrite, hOutRead, hOutWrite windows.Handle
	if err := windows.CreatePipe(&hInRead, &hInWrite, sa, 0); err != nil {
		return nil, fmt.Errorf("CreatePipe(stdin): %w", err)
	}
	if err := windows.CreatePipe(&hOutRead, &hOutWrite, sa, 0); err != nil {
		_ = windows.CloseHandle(hInRead)
		_ = windows.CloseHandle(hInWrite)
		return nil, fmt.Errorf("CreatePipe(stdout): %w", err)
	}

	// 创建伪控制台（flags=0；不使用 INHERIT_CURSOR 以与已知可用实现对齐）。
	var hPC windows.Handle
	size := windows.Coord{X: int16(cols), Y: int16(rows)}
	if err := windows.CreatePseudoConsole(size, hInRead, hOutWrite, 0, &hPC); err != nil {
		_ = windows.CloseHandle(hInRead)
		_ = windows.CloseHandle(hInWrite)
		_ = windows.CloseHandle(hOutRead)
		_ = windows.CloseHandle(hOutWrite)
		return nil, fmt.Errorf("CreatePseudoConsole: %w", err)
	}
	// 注意：不立即关闭 hInRead / hOutWrite（ConPTY 内部已 DuplicateHandle，但保留父侧副本
	// 到 cleanup 才关——与已知可用实现一致；提前关曾在部分环境下导致子进程 0xC0000142 初始化失败）。

	// 属性表：把 hPC 绑到子进程（PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE）。
	// 用 x/sys 的 helper：内部 LocalAlloc 分配 + 保活属性值指针防 GC，封装了
	// InitializeProcThreadAttributeList 的「两次调用拿 size」标准模式。
	attrList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.ClosePseudoConsole(hPC)
		_ = windows.CloseHandle(hInRead)
		_ = windows.CloseHandle(hInWrite)
		_ = windows.CloseHandle(hOutRead)
		_ = windows.CloseHandle(hOutWrite)
		return nil, fmt.Errorf("NewProcThreadAttributeList: %w", err)
	}
	// Delete 必须在 CreateProcess 调用之后（属性表此前仍被读取）。
	defer attrList.Delete()

	if err := attrList.Update(
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(hPC), // ★ PSEUDOCONSOLE 是特殊属性：lpValue 直接是 HPCON 值本身（指针大小），
		// Windows 不解引用。若传 &hPC（栈地址），子进程会拿到垃圾 HPCON 连不上 conhost，初始化失败 0xC0000142。
		unsafe.Sizeof(hPC),
	); err != nil {
		windows.ClosePseudoConsole(hPC)
		_ = windows.CloseHandle(hInRead)
		_ = windows.CloseHandle(hInWrite)
		_ = windows.CloseHandle(hOutRead)
		_ = windows.CloseHandle(hOutWrite)
		return nil, fmt.Errorf("UpdateProcThreadAttribute: %w", err)
	}

	// STARTUPINFOEX：Cb 必须是 EX 的大小，否则 CreateProcess 当普通 STARTUPINFO 处理，
	// 属性表被完全忽略，PTY 不会工作。
	var si windows.StartupInfoEx
	si.StartupInfo.Cb = uint32(unsafe.Sizeof(si))
	// STARTF_USESTDHANDLES：必须设置，否则子进程会尝试继承/共享父进程的控制台句柄，
	// 与伪控制台属性冲突，导致子进程 0xC0000142 (STATUS_DLL_INIT_FAILED) 初始化失败。
	// 实际 std 叨柄保持 0（NULL），由 PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE 接管提供。
	si.StartupInfo.Flags = windows.STARTF_USESTDHANDLES
	si.ProcThreadAttributeList = attrList.List()

	var pi windows.ProcessInformation
	// 构造干净的 Windows 环境块（不继承本进程可能被污染的 env，如 MSYS bash 的 HOME=/c/...）。
	// 这与 wt/Start-Process 给外部终端的 fresh env 等价，确保 claude 能正确解析 ~/.claude。
	envBlock := createCleanEnvBlock()
	defer destroyEnvBlock(envBlock)
	flags := uint32(windows.EXTENDED_STARTUPINFO_PRESENT)
	var envArg *uint16
	if envBlock != 0 {
		flags |= windows.CREATE_UNICODE_ENVIRONMENT
		envArg = (*uint16)(unsafe.Pointer(envBlock))
	}
	// bInheritHandles=FALSE：ConPTY 走属性表挂接，不走普通句柄继承。
	if err := windows.CreateProcess(
		nil, // lpApplicationName=nil，由 cmdline 首个 token 决定可执行文件
		cmdline16,
		nil, nil,   // 进程 / 线程安全属性
		false,      // bInheritHandles=FALSE
		flags,
		envArg, // 干净环境块（或 nil 回退继承）
		workdir16,
		&si.StartupInfo,
		&pi,
	); err != nil {
		windows.ClosePseudoConsole(hPC)
		_ = windows.CloseHandle(hInWrite)
		_ = windows.CloseHandle(hOutRead)
		return nil, fmt.Errorf("CreateProcess: %w", err)
	}
	_ = windows.CloseHandle(pi.Thread) // 只需进程句柄

	return &ptySession{
		hInWrite:  hInWrite,
		hOutRead:  hOutRead,
		hInRead:   hInRead,
		hOutWrite: hOutWrite,
		hPC:       hPC,
		hProc:     pi.Process,
		pid:       pi.ProcessId,
		stop:      make(chan struct{}),
		stopped:   make(chan struct{}),
		cleaned:   make(chan struct{}),
	}, nil
}

// outputLoop 用 PeekNamedPipe 轮询读取子进程输出并经 onData 推送。
//
// 为什么轮询而非阻塞 ReadFile：Windows 同步 ReadFile 在匿名管道上阻塞后，
// 无法从另一线程可靠打断（CloseHandle 不能保证唤醒它）。ConPTY 输出管道由 conhost 持有，
// 子进程退出时也不会 EOF，故阻塞读会永久卡住 cleanup。
// 轮询模型每 15ms 探测一次数据，有则读、无则睡；close(stop) 后下一轮即退出，cleanup 可靠收尾。
func (s *ptySession) outputLoop(onData func(string)) {
	defer crashlog.Recover()
	defer close(s.stopped)
	const bufSize = 4096
	buf := make([]byte, bufSize)
	for {
		select {
		case <-s.stop:
			return
		default:
		}
		avail, err := peekNamedPipeAvail(s.hOutRead)
		if err != nil {
			return // 管道断开 / 句柄已关
		}
		if avail == 0 {
			// 无数据：睡一小段（可被 stop 唤醒检查），避免空转
			select {
			case <-s.stop:
				return
			case <-time.After(15 * time.Millisecond):
			}
			continue
		}
		if int(avail) > len(buf) {
			avail = uint32(len(buf))
		}
		var n uint32
		if err := windows.ReadFile(s.hOutRead, buf[:avail], &n, nil); err != nil {
			return
		}
		if n > 0 && onData != nil {
			onData(string(buf[:n])) // ConPTY 输出即 UTF-8，直传无损（JSON round-trip 还原）
		}
	}
}

// Write 把数据写给子进程 stdin（前端键盘输入）。
func (s *ptySession) Write(data []byte) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	for len(data) > 0 {
		var written uint32
		if err := windows.WriteFile(s.hInWrite, data, &written, nil); err != nil {
			return err
		}
		if written == 0 {
			return fmt.Errorf("WriteFile 写入 0 字节")
		}
		data = data[written:]
	}
	return nil
}

// Resize 调整伪控制台尺寸。
func (s *ptySession) Resize(cols, rows int) error {
	return windows.ResizePseudoConsole(s.hPC, windows.Coord{X: int16(cols), Y: int16(rows)})
}

// Close 终止子进程并释放资源（幂等）。
// TerminateProcess 让 wait goroutine 的 WaitForSingleObject 返回并触发 cleanup；
// 再显式调 cleanup 兜底（若 wait 已 cleanup 则 no-op）。最后等 cleanup 完成。
func (s *ptySession) Close() {
	if s.hProc != 0 {
		_ = windows.TerminateProcess(s.hProc, 1)
	}
	s.cleanup()
	select {
	case <-s.cleaned:
	case <-time.After(2 * time.Second): // 兜底，防 wait goroutine 卡住拖垮调用方
	}
}

// cleanup 幂等释放全部资源。由 wait goroutine（子进程退出）或 Close（用户关 tab）触发，先到者执行。
//
// 顺序（敏感，乱序会死锁或泄漏）：
//  1. CloseHandle(hOutRead)：顶醒阻塞中的 ReadFile，让 outputLoop 退出
//  2. 等 <-stopped：确保读循环已停（否则它仍引用 hPC 关联管道，ClosePseudoConsole 会卡）
//  3. ClosePseudoConsole：必须在 CloseHandle(hInWrite) 之前（conhost host 仍引用写管道）
//  4. CloseHandle(hInWrite / hProc)：收尾
func (s *ptySession) cleanup() {
	s.once.Do(func() {
		// 1. close(stop)：唤醒 outputLoop 轮询循环，让它退出
		close(s.stop)
		select {
		case <-s.stopped:
		case <-time.After(500 * time.Millisecond): // 兜底，防读循环卡死拖垮退出
		}
		// 2. 关闭 PTY（必须在关写端之前：conhost host 仍引用写管道）
		windows.ClosePseudoConsole(s.hPC)
		// 3. 关闭剩余句柄
		_ = windows.CloseHandle(s.hOutRead)
		_ = windows.CloseHandle(s.hInWrite)
		_ = windows.CloseHandle(s.hInRead)
		_ = windows.CloseHandle(s.hOutWrite)
		if s.hProc != 0 {
			_ = windows.CloseHandle(s.hProc)
		}
		close(s.cleaned)
	})
}

// exitCode 取子进程退出码；进程仍在运行则返回 0。
func (s *ptySession) exitCode() int {
	if s.hProc == 0 {
		return 0
	}
	var code uint32
	if err := windows.GetExitCodeProcess(s.hProc, &code); err != nil || code == stillActive {
		return 0
	}
	return int(code)
}

// info 返回会话信息（PTYRegistry.List 用）。
func (s *ptySession) info() TerminalInfo {
	return TerminalInfo{
		ID:      s.id,
		PID:     s.pid,
		Kind:    s.kind,
		Workdir: s.workdir,
		Live:    true,
	}
}
