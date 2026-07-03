//go:build windows

package monitor

import (
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func init() {
	Injector = &windowsInjector{}
}

type windowsInjector struct{}

// consoleMu 串行化控制台附加/写入全流程。
// AttachConsole/FreeConsole/WriteConsoleInput 操作的是进程级全局控制台状态，
// 不是线程局部的：SendPrompt 主调用与 autoConfirmModelSwitch 后台重试可能并发，
// 不加锁会互相 Free 掉对方刚 Attach 的控制台，令句柄失效（ERROR_INVALID_HANDLE）。
var consoleMu sync.Mutex

// ---- Win32 DLL 声明 ----

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procAttachConsole     = kernel32.NewProc("AttachConsole")
	procFreeConsole       = kernel32.NewProc("FreeConsole")
	procWriteConsoleInput = kernel32.NewProc("WriteConsoleInputW")
	procGetConsoleWindow  = kernel32.NewProc("GetConsoleWindow")

	user32DLL = syscall.NewLazyDLL("user32.dll")

	procGetAncestor              = user32DLL.NewProc("GetAncestor")
	procShowWindow               = user32DLL.NewProc("ShowWindow")
	procSetForegroundWindow      = user32DLL.NewProc("SetForegroundWindow")
	procEnumWindows              = user32DLL.NewProc("EnumWindows")
	procGetWindowThreadProcessId = user32DLL.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32DLL.NewProc("IsWindowVisible")
	procAttachThreadInput        = user32DLL.NewProc("AttachThreadInput")
	procGetCurrentThreadId       = kernel32.NewProc("GetCurrentThreadId")
	procGetWindowTextLengthW     = user32DLL.NewProc("GetWindowTextLengthW")
	procAllowSetForegroundWindow = user32DLL.NewProc("AllowSetForegroundWindow")
	procGetClassNameW            = user32DLL.NewProc("GetClassNameW")
	procBringWindowToTop         = user32DLL.NewProc("BringWindowToTop")
	procPostMessageW             = user32DLL.NewProc("PostMessageW")
	procGetCurrentProcessId      = kernel32.NewProc("GetCurrentProcessId")
)

// ---- Win32 控制台输入记录常量/结构 ----

const eventTypeKey = 0x0001 // INPUT_RECORD::EventType == KEY_EVENT

const (
	vkBack    = 0x08
	vkTab     = 0x09
	vkReturn  = 0x0D
	vkEscape  = 0x1B
	vkSpace   = 0x20
	vkLeft    = 0x25
	vkUp      = 0x26
	vkRight   = 0x27
	vkDown    = 0x28
	vkDelete  = 0x2E
	vkA       = 0x41
	swRestore = 9 // SW_RESTORE
	wmClose   = 0x0010
)

const leftCtrlPressed = 0x0008 // KEY_EVENT_RECORD::dwControlKeyState LEFT_CTRL_PRESSED

// keyEventRecord 严格对应 Win32 KEY_EVENT_RECORD（16 字节，无填充）。
type keyEventRecord struct {
	bKeyDown          int32
	wRepeatCount      uint16
	wVirtualKeyCode   uint16
	wVirtualScanCode  uint16
	uChar             uint16 // WCHAR：控制台用它来还原字符
	dwControlKeyState uint32
}

// inputRecord 对应 Win32 INPUT_RECORD（20 字节）：
// EventType(2) + 对齐(2) + 16 字节联合体。
type inputRecord struct {
	eventType uint16
	_         [2]byte
	event     [16]byte // 联合体：写入时按 keyEventRecord 重叠解释
}

// vkToScanCode 返回虚拟键对应的标准键盘扫描码(Set 1)。
// 字符键靠 uChar 被控制台识别,但方向键/空格/Tab 等控制键 uChar=0,
// 控制台必须靠 wVirtualScanCode 才能识别——漏设会让 WriteConsoleInput 注入的
// 方向键被目标进程忽略(实测:Claude Code 终端选单点中间项无效,只回车选了第一项)。
func vkToScanCode(vk uint16) uint16 {
	switch vk {
	case vkBack:
		return 0x0E
	case vkTab:
		return 0x0F
	case vkReturn:
		return 0x1C
	case vkEscape:
		return 0x01
	case vkSpace:
		return 0x39
	case vkA:
		return 0x1E
	case vkLeft:
		return 0x4B
	case vkUp:
		return 0x48
	case vkRight:
		return 0x4D
	case vkDown:
		return 0x50
	case vkDelete:
		return 0x53
	}
	return 0
}

func makeKeyRecord(down bool, vk uint16, ch uint16) inputRecord {
	return makeKeyRecordWithState(down, vk, ch, 0)
}

func makeKeyRecordWithState(down bool, vk uint16, ch uint16, controlState uint32) inputRecord {
	kev := keyEventRecord{
		bKeyDown:          boolToInt32(down),
		wRepeatCount:      1,
		wVirtualKeyCode:   vk,
		wVirtualScanCode:  vkToScanCode(vk),
		uChar:             ch,
		dwControlKeyState: controlState,
	}
	var ir inputRecord
	ir.eventType = eventTypeKey
	*(*keyEventRecord)(unsafe.Pointer(&ir.event[0])) = kev
	return ir
}

func boolToInt32(b bool) int32 {
	if b {
		return 1
	}
	return 0
}

// textRecords 把字符串拆成「逐字符 按下+抬起」的输入记录（按 UTF-16 码元）。
func textRecords(text string) []inputRecord {
	units := utf16.Encode([]rune(text))
	recs := make([]inputRecord, 0, len(units)*2)
	for _, u := range units {
		recs = append(recs, makeKeyRecord(true, 0, u))
		recs = append(recs, makeKeyRecord(false, 0, u))
	}
	return recs
}

// withEnter 末尾追加一个回车（VK_RETURN），用于提交输入。
func withEnter(recs []inputRecord) []inputRecord {
	return append(recs,
		makeKeyRecord(true, vkReturn, '\r'),
		makeKeyRecord(false, vkReturn, '\r'),
	)
}

// escapeRecords 产生两次 ESC「按下+抬起」——Claude Code 中等价于「回溯」。
func escapeRecords() []inputRecord {
	var recs []inputRecord
	for i := 0; i < 2; i++ {
		recs = append(recs,
			makeKeyRecord(true, vkEscape, 0x1B),
			makeKeyRecord(false, vkEscape, 0x1B),
		)
	}
	return recs
}

// sendInputRecords 把按键记录分批投递到指定进程所附属控制台的输入缓冲区。
// 控制台输入缓冲区通常仅 256 条记录，长文本一次性写入会导致末尾回车被丢弃，
// 文本出现在输入框但未提交。分批写入 + 批次间短暂休眠让目标进程有时机消费。
func sendInputRecords(pid uint32, recs []inputRecord) error {
	if len(recs) == 0 {
		return nil
	}

	consoleMu.Lock()
	defer consoleMu.Unlock()

	// 先尝试 detach（自身无控制台时为无害空操作），避免因「已附属控制台」而失败。
	_, _, _ = procFreeConsole.Call()

	r, _, attachErr := procAttachConsole.Call(uintptr(pid))
	if r == 0 {
		return fmt.Errorf("无法附加到该实例的控制台（PID %d，错误 %v）。\n请确认它在普通终端窗口里运行；经管道/重定向启动的实例不支持", pid, attachErr)
	}
	defer func() { _, _, _ = procFreeConsole.Call() }()

	// 用 CONIN$ 设备名打开当前附加控制台的输入缓冲区，而非 GetStdHandle(STD_INPUT_HANDLE)。
	// cc-console 是 windowsgui 子系统程序，启动时没有标准控制台句柄，STDIN 表项指向
	// null device（非 NULL）。AttachConsole 成功后 Windows 只在表项为 NULL 时才填充它，
	// 于是 GetStdHandle 返回的是 null device 句柄——非零（骗过 h==0 检查）但不是控制台
	// 输入缓冲区，WriteConsoleInput 拿到它就报 ERROR_INVALID_HANDLE("The handle is invalid")。
	// CONIN$ 直接解析到「当前附加控制台」的输入缓冲区，始终可靠。该句柄需自行 Close。
	h, err := openConsoleInput()
	if err != nil || h == 0 || h == windows.InvalidHandle {
		return fmt.Errorf("打开控制台输入缓冲区失败: %v", err)
	}
	defer windows.CloseHandle(h)

	// 控制台输入缓冲区容量有限，且中文等宽字符目标进程消费较慢。
	// 若一次性写入过多记录，末尾记录（往往是回车）会被挤掉，
	// 表现为「文本出现但未发送」。故：
	//   1. 每批控制在 batchRecords 条，给目标进程留出消费时间
	//   2. 检查实际写入数，缓冲区满导致部分写入时短暂休眠后重试剩余部分
	const batchRecords = 64
	const backoff = 15 * time.Millisecond
	for offset := 0; offset < len(recs); {
		end := offset + batchRecords
		if end > len(recs) {
			end = len(recs)
		}
		batch := recs[offset:end]
		var written uint32
		r, _, e := procWriteConsoleInput.Call(
			uintptr(h),
			uintptr(unsafe.Pointer(&batch[0])),
			uintptr(len(batch)),
			uintptr(unsafe.Pointer(&written)),
		)
		if r == 0 {
			return fmt.Errorf("WriteConsoleInput 失败: %v", e)
		}
		// 部分写入（written < 期望）：缓冲区已满，等待目标进程消费后重试未写入部分
		if int(written) < len(batch) {
			offset += int(written)
			time.Sleep(backoff)
			continue
		}
		offset = end
		// 批次之间给目标进程时间消费输入，避免下一批写入时缓冲区仍满
		if offset < len(recs) {
			time.Sleep(backoff)
		}
	}
	return nil
}

// openConsoleInput 打开「当前进程所附加控制台」的输入缓冲区句柄（CONIN$）。
// 用设备名而非 GetStdHandle，原因见 sendInputRecords 注释。调用方负责 CloseHandle。
func openConsoleInput() (windows.Handle, error) {
	name, _ := windows.UTF16PtrFromString("CONIN$")
	return windows.CreateFile(
		name,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		0,
		0,
	)
}

// ---- ConsoleInput 接口实现 ----

func (w *windowsInjector) SendClear(pid int) error {
	return sendInputRecords(uint32(pid), withEnter(textRecords("/clear")))
}

func (w *windowsInjector) SendRewind(pid int) error {
	return sendInputRecords(uint32(pid), escapeRecords())
}

func (w *windowsInjector) SendPrompt(pid int, text string) error {
	// 先注入文本，等待目标进程消费完（尤其中文宽字符消费较慢），再单独注入回车。
	// 文本与回车同批注入时，末尾回车易被控制台输入缓冲区挤掉，
	// 表现为「文本已出现在输入框但未发送」。
	if err := sendInputRecords(uint32(pid), textRecords(text)); err != nil {
		return err
	}
	time.Sleep(50 * time.Millisecond)
	if err := sendInputRecords(uint32(pid), withEnter(nil)); err != nil {
		return err
	}
	// /model <name> 跨档位切换会弹 TUI 确认列表（默认高亮「Yes, switch」）。
	// 该提示直接画在终端屏幕上、不写进转录 JSONL，消息框看不到，用户无从确认。
	// 后台隔 1s 补一个回车、共 3 次：命中提示时确认切换；未弹提示（直接切换）时
	// 空回车落在主输入框被 Claude Code 忽略，无害。多次重试是为应对提示渲染时机不确定。
	// 后台 goroutine 不阻塞前端调用返回。
	if isModelSwitch(text) {
		go autoConfirmModelSwitch(uint32(pid))
	}
	return nil
}

// autoConfirmModelSwitch 后台间隔发送回车，确认 /model 切换提示。
// 忽略每次发送的错误（实例已退出等情况无需处理）。
func autoConfirmModelSwitch(pid uint32) {
	const retries = 3
	const interval = 1 * time.Second
	for range retries {
		time.Sleep(interval)
		_ = sendInputRecords(pid, withEnter(nil))
	}
}

// isModelSwitch 判断输入是否为带参数的 /model 切换命令。
// 必须带参数，避免裸 /model 弹出模型选择器时被自动回车误选某项。
func isModelSwitch(text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "/model") {
		return false
	}
	return strings.TrimSpace(strings.TrimPrefix(t, "/model")) != ""
}

// arrowRecord 产生单个虚拟键的「按下+抬起」KEY_EVENT 记录(方向键,uChar=0,靠 vk+scan code)。
func arrowRecord(vk uint16) []inputRecord {
	return []inputRecord{
		makeKeyRecord(true, vk, 0),
		makeKeyRecord(false, vk, 0),
	}
}

func ctrlARecords() []inputRecord {
	return []inputRecord{
		makeKeyRecordWithState(true, vkA, 0x01, leftCtrlPressed),
		makeKeyRecordWithState(false, vkA, 0x01, leftCtrlPressed),
	}
}

func clearInputRecords() []inputRecord {
	recs := ctrlARecords()
	recs = append(recs, arrowRecord(vkBack)...)
	return recs
}

// keyTokenRecords 把单个控制键 token 翻译为输入记录。
// 方向键走 KEY_EVENT(虚拟键码 + 扫描码);空格/Tab 走字符注入;回车走 VK_RETURN。
// 调试按钮可逐个发送,用于摸清 claude 终端对各键的真实响应。
func keyTokenRecords(key string) ([]inputRecord, error) {
	switch key {
	case "left":
		return arrowRecord(vkLeft), nil
	case "right":
		return arrowRecord(vkRight), nil
	case "up":
		return arrowRecord(vkUp), nil
	case "down":
		return arrowRecord(vkDown), nil
	case "backspace":
		return arrowRecord(vkBack), nil
	case "delete":
		return arrowRecord(vkDelete), nil
	case "esc":
		return arrowRecord(vkEscape), nil
	case "ctrl+a":
		return ctrlARecords(), nil
	case "clearInput":
		return clearInputRecords(), nil
	case "space":
		return textRecords(" "), nil
	case "tab":
		return textRecords("\t"), nil
	case "enter":
		return withEnter(nil), nil
	default:
		return nil, fmt.Errorf("未知按键 token: %q", key)
	}
}

// actionToken 对应前端 buildAskSequence 输出的一个按键 token。
// Key 非空时为控制键（方向键/空格/Tab/回车）；Text 非空时为待注入文本。
type actionToken struct {
	Key  string `json:"key,omitempty"`
	Text string `json:"text,omitempty"`
}

// SendAskAnswer 按 token 序列向目标实例投递按键事件，用于驱动 AskUserQuestion 的终端选择 UI。
// 遇到 {text} 段时采用两段式投递：先发前置控制键、sleep、再发文本、sleep、再发后续控制键，
// 避免控制台输入缓冲区（约 256 条）在中文宽字符消费较慢时挤掉末尾回车（同 SendPrompt 经验）。
func (w *windowsInjector) SendAskAnswer(pid int, actions string) error {
	var tokens []actionToken
	if err := json.Unmarshal([]byte(actions), &tokens); err != nil {
		return fmt.Errorf("actions JSON 解析失败: %w", err)
	}
	upid := uint32(pid)
	// flush 投递一批记录并留出消费窗口。
	flush := func(recs []inputRecord) error {
		if len(recs) == 0 {
			return nil
		}
		if err := sendInputRecords(upid, recs); err != nil {
			return err
		}
		time.Sleep(50 * time.Millisecond)
		return nil
	}

	var pending []inputRecord // 累积控制键，遇到 text 前先投递
	for _, tk := range tokens {
		if tk.Text != "" {
			if err := flush(pending); err != nil {
				return err
			}
			pending = nil
			if err := flush(textRecords(tk.Text)); err != nil {
				return err
			}
			continue
		}
		recs, err := keyTokenRecords(tk.Key)
		if err != nil {
			return err
		}
		pending = append(pending, recs...)
	}
	if len(pending) > 0 {
		return sendInputRecords(upid, pending)
	}
	return nil
}

func (w *windowsInjector) ShowWindow(pid int) error {
	_, _, _ = procFreeConsole.Call()

	// ---- 路径 1：原生控制台窗口（conhost）----
	r, _, _ := procAttachConsole.Call(uintptr(pid))
	if r != 0 {
		r, _, _ = procGetConsoleWindow.Call()
		hwnd := uintptr(r)
		if hwnd != 0 {
			// 直接使用 GetConsoleWindow 返回的窗口：
			//   独立控制台 → PseudoConsoleWindow / ConsoleWindowClass → 合法目标
			//   ConPTY 内嵌 → AttachConsole 通常直接失败，走不到这里
			if ro, _, _ := procGetAncestor.Call(hwnd, 3); ro != 0 {
				hwnd = ro
			}
			procShowWindow.Call(hwnd, uintptr(swRestore))
			procSetForegroundWindow.Call(hwnd)
			_, _, _ = procFreeConsole.Call()
			return nil
		}
		_, _, _ = procFreeConsole.Call()
	}

	// ---- 路径 2：ConPTY 伪控制台（IDE 内嵌终端等，无原生 HWND）----
	// 沿进程祖先链向上查找拥有可见顶层窗口的进程
	hwnd := findWindowForPID(uint32(pid))
	if hwnd == 0 {
		// 回退：反向搜索——枚举所有顶层窗口，检查目标 PID 是否在后代中
		hwnd = reverseFindWindow(uint32(pid))
	}
	if hwnd == 0 {
		return fmt.Errorf("未找到窗口（PID %d）\n该实例可能运行在无窗口环境中", pid)
	}

	// 多步组合绕过 Windows 焦点锁定机制：
	//   1. AllowSetForegroundWindow 授予当前进程置前权限
	//   2. AttachThreadInput 连接两个线程的输入队列（绕过 Vista+ 限制）
	//   3. ShowWindow SW_RESTORE 还原最小化窗口
	//   4. SetForegroundWindow + BringWindowToTop 强制置前
	curPID, _, _ := procGetCurrentProcessId.Call()
	procAllowSetForegroundWindow.Call(curPID) // ASFW_ANY = 当前进程

	targetThread, _, _ := procGetWindowThreadProcessId.Call(hwnd, 0)
	curThread, _, _ := procGetCurrentThreadId.Call()

	if curThread != targetThread {
		procAttachThreadInput.Call(curThread, targetThread, 1)
		procShowWindow.Call(hwnd, uintptr(swRestore))
		procSetForegroundWindow.Call(hwnd)
		procBringWindowToTop.Call(hwnd)
		procAttachThreadInput.Call(curThread, targetThread, 0)
	} else {
		procShowWindow.Call(hwnd, uintptr(swRestore))
		procSetForegroundWindow.Call(hwnd)
		procBringWindowToTop.Call(hwnd)
	}
	return nil
}

type closeWindowCandidate struct {
	hwnd uintptr
	safe bool
	desc string
}

func (w *windowsInjector) CloseInstance(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("PID 无效")
	}
	if processCreateMs(uint32(pid)) == 0 {
		return "", fmt.Errorf("PID %d 不存在或已退出", pid)
	}
	candidate := resolveCloseWindow(uint32(pid)) // 先定位窗口；进程退出后祖先链可能断开
	if err := terminateProcessTree(uint32(pid)); err != nil {
		return "", err
	}
	time.Sleep(250 * time.Millisecond)
	if candidate.hwnd == 0 {
		return fmt.Sprintf("已关闭 PID %d；未找到可关闭的独立终端窗口", pid), nil
	}
	if !candidate.safe {
		return fmt.Sprintf("已关闭 PID %d；终端窗口疑似共享宿主（%s），已保留", pid, candidate.desc), nil
	}
	r, _, _ := procPostMessageW.Call(candidate.hwnd, uintptr(wmClose), 0, 0)
	if r == 0 {
		return fmt.Sprintf("已关闭 PID %d；终端窗口关闭请求未送达（窗口可能已消失）", pid), nil
	}
	return fmt.Sprintf("已关闭 PID %d，并已请求关闭对应终端窗口", pid), nil
}

func resolveCloseWindow(pid uint32) closeWindowCandidate {
	_, _, _ = procFreeConsole.Call()
	r, _, _ := procAttachConsole.Call(uintptr(pid))
	if r != 0 {
		r, _, _ = procGetConsoleWindow.Call()
		hwnd := uintptr(r)
		if hwnd != 0 {
			if ro, _, _ := procGetAncestor.Call(hwnd, 3); ro != 0 {
				hwnd = ro
			}
			_, _, _ = procFreeConsole.Call()
			return classifyCloseWindow(hwnd)
		}
		_, _, _ = procFreeConsole.Call()
	}
	hwnd := findWindowForPID(pid)
	if hwnd == 0 {
		hwnd = reverseFindWindow(pid)
	}
	if hwnd == 0 {
		return closeWindowCandidate{}
	}
	return classifyCloseWindow(hwnd)
}

func classifyCloseWindow(hwnd uintptr) closeWindowCandidate {
	cls := windowClassName(hwnd)
	if isConsoleWindowClass(hwnd) {
		return closeWindowCandidate{hwnd: hwnd, safe: true, desc: cls}
	}
	if isCascadiaWindow(hwnd) {
		return closeWindowCandidate{hwnd: hwnd, safe: false, desc: "Windows Terminal"}
	}
	if cls == "" {
		cls = "未知窗口"
	}
	return closeWindowCandidate{hwnd: hwnd, safe: false, desc: cls}
}

func windowClassName(hwnd uintptr) string {
	var class [128]uint16
	procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&class[0])), uintptr(len(class)))
	return windows.UTF16ToString(class[:])
}

func terminateProcessTree(root uint32) error {
	for _, child := range collectDescendants(root) {
		_ = terminateSingleProcess(child) // 子进程可能已自然退出，忽略并继续关闭主进程
	}
	return terminateSingleProcess(root)
}

func collectDescendants(root uint32) []uint32 {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil
	}
	defer windows.CloseHandle(snapshot)
	children := map[uint32][]uint32{}
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snapshot, &pe); err != nil {
		return nil
	}
	for {
		children[pe.ParentProcessID] = append(children[pe.ParentProcessID], pe.ProcessID)
		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}
	var out []uint32
	var walk func(uint32)
	walk = func(pid uint32) {
		for _, child := range children[pid] {
			walk(child)
			out = append(out, child)
		}
	}
	walk(root)
	return out
}

func terminateSingleProcess(pid uint32) error {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, pid)
	if err != nil {
		if processCreateMs(pid) == 0 {
			return nil
		}
		return fmt.Errorf("打开 PID %d 失败: %w", pid, err)
	}
	defer windows.CloseHandle(h)
	if err := windows.TerminateProcess(h, 1); err != nil {
		if processCreateMs(pid) == 0 {
			return nil
		}
		return fmt.Errorf("终止 PID %d 失败: %w", pid, err)
	}
	_, _ = windows.WaitForSingleObject(h, 1500)
	return nil
}

// getParentPID 返回 pid 的父进程 PID，失败返回 0。
func getParentPID(pid uint32) uint32 {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return 0
	}
	defer windows.CloseHandle(snapshot)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snapshot, &pe); err != nil {
		return 0
	}
	for {
		if pe.ProcessID == pid {
			return pe.ParentProcessID
		}
		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}
	return 0
}

// reverseFindWindow 是 findWindowForPID 的回退方案：
// 枚举所有可见顶层窗口，对每个窗口检查目标 PID 是否在其后代进程中。
// 返回第一个匹配的窗口句柄，未找到返回 0。
func reverseFindWindow(target uint32) uintptr {
	// 先构建目标 PID 的祖先集合（单次快照）
	ancestors := make(map[uint32]bool)
	ancestors[target] = true
	current := target
	for range 10 {
		parent := getParentPID(current)
		if parent == 0 || parent == current {
			break
		}
		ancestors[parent] = true
		current = parent
	}

	// 枚举所有顶层窗口，找第一个属于祖先集的可见窗口
	var result uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, lParam uintptr) uintptr {
		var wndPID uint32
		procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&wndPID)))
		if ancestors[wndPID] && !isShellProcess(wndPID) {
			vis, _, _ := procIsWindowVisible.Call(hwnd)
			if vis != 0 {
				titleLen, _, _ := procGetWindowTextLengthW.Call(hwnd)
				if titleLen > 0 || isConsoleWindowClass(hwnd) {
					result = hwnd
					return 0 // 停止枚举
				}
			}
		}
		return 1 // 继续
	})
	procEnumWindows.Call(cb, 0)
	return result
}

// findWindowForPID 沿进程祖先链向上查找拥有可见顶层窗口的进程，
// 最多向上追溯 5 级。跳过 cmd.exe / powershell.exe 等 shell 进程，
// 因为它们在 ConPTY 下会产生「幽灵」可见窗口（实际无法被 SetForegroundWindow 拉起）。
func findWindowForPID(pid uint32) uintptr {
	current := pid
	for range 10 {
		hwnd := findTopLevelWindow(current)
		if hwnd != 0 && !isShellProcess(current) {
			return hwnd
		}
		parent := getParentPID(current)
		if parent == 0 || parent == current {
			break
		}
		current = parent
	}
	return 0
}

// isShellProcess 判断进程是否是不应作为窗口目标的进程（shell 解释器、系统进程）。
// explorer.exe 等系统进程永远不应被 SetForegroundWindow。
// 注意：conhost.exe / OpenConsole.exe 不在此列——它们是 Path 1 的合法窗口目标。
func isShellProcess(pid uint32) bool {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snapshot)

	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := windows.Process32First(snapshot, &pe); err != nil {
		return false
	}
	for {
		if pe.ProcessID == pid {
			name := strings.ToLower(windows.UTF16ToString(pe.ExeFile[:]))
			return isShellExeName(name)
		}
		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}
	return false
}

// isShellExeName 判断进程名是否属于应跳过的进程：
//   - shell 解释器（控制台子系统，无自有窗口）
//   - 系统进程（explorer.exe 等，永远不应作为目标，到达说明祖先链已越界）
func isShellExeName(name string) bool {
	switch name {
	// Windows 自带 shell
	case "cmd.exe", "powershell.exe", "pwsh.exe":
		return true
	// Unix shell（Git Bash / MSYS2 / Cygwin / WSL）
	case "bash.exe", "sh.exe", "zsh.exe", "fish.exe", "dash.exe":
		return true
	// 系统进程 —— 到此说明祖先链已越界，绝不应返回其窗口
	case "explorer.exe", "svchost.exe", "csrss.exe",
		"wininit.exe", "winlogon.exe", "services.exe", "lsass.exe":
		return true
	}
	return false
}

// isConsoleWindowShell 判断 GetConsoleWindow 返回的窗口是否属于 shell 进程。
// ConPTY 下 GetConsoleWindow 会返回 shell（powershell/cmd）的终端面板窗口，
// 该窗口虽然可见但无法被 SetForegroundWindow 正常拉起，需走祖先链回溯。
func isConsoleWindowShell(hwnd uintptr) bool {
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	return pid != 0 && isShellProcess(pid)
}

// isConsoleWindowClass 判断窗口类名是否为控制台/伪控制台窗口。
// PseudoConsoleWindow（独立 PowerShell/cmd）和 ConsoleWindowClass（conhost）
// 即使标题为空也是合法的窗口目标。
func isConsoleWindowClass(hwnd uintptr) bool {
	var class [64]uint16
	procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&class[0])), 64)
	name := windows.UTF16ToString(class[:])
	return name == "PseudoConsoleWindow" || name == "ConsoleWindowClass"
}

// findTopLevelWindow 枚举顶层窗口，返回属于 pid 的第一个可见窗口句柄。
func findTopLevelWindow(pid uint32) uintptr {
	var result uintptr

	target := &struct {
		pid   uint32
		hwnd  uintptr
		found bool
	}{pid: pid}

	cb := syscall.NewCallback(func(hwnd uintptr, lParam uintptr) uintptr {
		var wndPID uint32
		procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&wndPID)))
		if wndPID == target.pid {
			vis, _, _ := procIsWindowVisible.Call(hwnd)
			if vis != 0 {
				// 主窗口必须有标题；但 PseudoConsoleWindow / ConsoleWindowClass 即使标题为空也是合法目标
				titleLen, _, _ := procGetWindowTextLengthW.Call(hwnd)
				if titleLen > 0 || isConsoleWindowClass(hwnd) {
					target.hwnd = hwnd
					target.found = true
					return 0 // 停止枚举
				}
			}
		}
		return 1 // 继续枚举
	})

	procEnumWindows.Call(cb, 0)
	if target.found {
		result = target.hwnd
	}
	return result
}
