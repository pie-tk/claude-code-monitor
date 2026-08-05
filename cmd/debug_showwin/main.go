//go:build windows

package main

import (
	"fmt"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// ---- Win32 声明 ----

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")

	procAttachConsole             = kernel32.NewProc("AttachConsole")
	procFreeConsole               = kernel32.NewProc("FreeConsole")
	procGetConsoleWindow          = kernel32.NewProc("GetConsoleWindow")
	procGetCurrentProcessId       = kernel32.NewProc("GetCurrentProcessId")
	procGetCurrentThreadId        = kernel32.NewProc("GetCurrentThreadId")

	procGetAncestor               = user32.NewProc("GetAncestor")
	procShowWindow                = user32.NewProc("ShowWindow")
	procSetForegroundWindow       = user32.NewProc("SetForegroundWindow")
	procAllowSetForegroundWindow  = user32.NewProc("AllowSetForegroundWindow")
	procAttachThreadInput         = user32.NewProc("AttachThreadInput")
	procBringWindowToTop          = user32.NewProc("BringWindowToTop")
	procEnumWindows               = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessId  = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible           = user32.NewProc("IsWindowVisible")
	procGetWindowTextLengthW      = user32.NewProc("GetWindowTextLengthW")
	procGetWindowTextW            = user32.NewProc("GetWindowTextW")
)

const SW_RESTORE = 9

func getProcessName(pid uint32) string {
	snapshot, _ := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if snapshot == 0 {
		return "?"
	}
	defer windows.CloseHandle(snapshot)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	windows.Process32First(snapshot, &pe)
	for {
		if pe.ProcessID == pid {
			return windows.UTF16ToString(pe.ExeFile[:])
		}
		if err := windows.Process32Next(snapshot, &pe); err != nil {
			break
		}
	}
	return "?"
}

func getParentPID(pid uint32) uint32 {
	snapshot, _ := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if snapshot == 0 {
		return 0
	}
	defer windows.CloseHandle(snapshot)
	var pe windows.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	windows.Process32First(snapshot, &pe)
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

func isShellProcess(pid uint32) bool {
	name := strings.ToLower(getProcessName(pid))
	return name == "cmd.exe" || name == "powershell.exe" || name == "pwsh.exe"
}

func getWindowTitle(hwnd uintptr) string {
	titleLen, _, _ := procGetWindowTextLengthW.Call(hwnd)
	if titleLen == 0 {
		return ""
	}
	buf := make([]uint16, titleLen+1)
	procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(titleLen+1))
	return windows.UTF16ToString(buf)
}

// findTopLevelWindow 等同于主程序逻辑
func findTopLevelWindow(pid uint32) (uintptr, string) {
	target := &struct {
		pid   uint32
		hwnd  uintptr
		title string
		found bool
	}{pid: pid}

	cb := syscall.NewCallback(func(hwnd uintptr, lParam uintptr) uintptr {
		var wndPID uint32
		procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&wndPID)))
		if wndPID == target.pid {
			vis, _, _ := procIsWindowVisible.Call(hwnd)
			if vis != 0 {
				titleLen, _, _ := procGetWindowTextLengthW.Call(hwnd)
				if titleLen > 0 {
					target.hwnd = hwnd
					target.title = getWindowTitle(hwnd)
					target.found = true
					return 0
				}
			}
		}
		return 1
	})

	procEnumWindows.Call(cb, 0)
	if target.found {
		return target.hwnd, target.title
	}
	return 0, ""
}

// findWindowForPID 等同于主程序逻辑
func findWindowForPID(pid uint32) (uintptr, string) {
	current := pid
	for level := range 5 {
		name := getProcessName(current)
		fmt.Printf("  [level %d] PID=%d name=%s\n", level, current, name)

		hwnd, title := findTopLevelWindow(current)
		if hwnd != 0 {
			fmt.Printf("           → found visible titled window: hwnd=0x%x title=%q\n", hwnd, title)
			if !isShellProcess(current) {
				fmt.Printf("           → NOT shell, ACCEPTING\n")
				return hwnd, title
			}
			fmt.Printf("           → IS shell (cmd/powershell), SKIPPING\n")
		} else {
			fmt.Printf("           → no visible titled window\n")
		}

		parent := getParentPID(current)
		if parent == 0 || parent == current {
			fmt.Printf("           parent=%d, stopping\n", parent)
			break
		}
		fmt.Printf("           parent=%d (%s)\n", parent, getProcessName(parent))
		current = parent
	}
	return 0, ""
}

// tryConsoleApproach 尝试路径 1（AttachConsole → GetConsoleWindow）
func tryConsoleApproach(pid uint32) (uintptr, error) {
	fmt.Println()
	fmt.Println("=== 路径 1: AttachConsole → GetConsoleWindow ===")

	procFreeConsole.Call()

	r, _, err := procAttachConsole.Call(uintptr(pid))
	fmt.Printf("  AttachConsole(pid=%d) → %d (err=%v)\n", pid, r, err)
	if r == 0 {
		procFreeConsole.Call()
		return 0, fmt.Errorf("AttachConsole failed")
	}

	r, _, _ = procGetConsoleWindow.Call()
	fmt.Printf("  GetConsoleWindow() → 0x%x\n", r)
	if r == 0 {
		procFreeConsole.Call()
		return 0, fmt.Errorf("GetConsoleWindow returned NULL (ConPTY)")
	}

	hwnd := uintptr(r)

	// 检查窗口是否属于 shell 进程（ConPTY）
	var ownerPID uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&ownerPID)))
	ownerName := getProcessName(ownerPID)
	fmt.Printf("  窗口属主: PID=%d name=%s\n", ownerPID, ownerName)
	if isShellProcess(ownerPID) {
		fmt.Printf("  ⚠ 属主是 shell 进程，路径 1 跳过，走路径 2\n")
		procFreeConsole.Call()
		return 0, fmt.Errorf("console window owned by shell process")
	}

	if ro, _, _ := procGetAncestor.Call(hwnd, 3); ro != 0 {
		fmt.Printf("  GetAncestor(GA_ROOT) → 0x%x (was 0x%x)\n", ro, hwnd)
		hwnd = ro
	}
	fmt.Printf("  ✓ 路径 1 成功: hwnd=0x%x\n", hwnd)
	procFreeConsole.Call()
	return hwnd, nil
}

// tryBringToFront 尝试用各种方式把目标窗口拉到前台
func tryBringToFront(hwnd uintptr) {
	fmt.Println()
	fmt.Printf("=== 尝试置前 hwnd=0x%x title=%q ===\n", hwnd, getWindowTitle(hwnd))

	// Step 1: AllowSetForegroundWindow
	fmt.Println()
	fmt.Println("--- Step 1: AllowSetForegroundWindow ---")
	curPID, _, _ := procGetCurrentProcessId.Call()
	fmt.Printf("  GetCurrentProcessId() → %d\n", curPID)
	r, _, _ := procAllowSetForegroundWindow.Call(curPID)
	fmt.Printf("  AllowSetForegroundWindow(pid=%d) → %d (0=fail)\n", curPID, r)

	// Step 2: AttachThreadInput
	fmt.Println()
	fmt.Println("--- Step 2: AttachThreadInput ---")
	targetThread, _, _ := procGetWindowThreadProcessId.Call(hwnd, 0)
	curThread, _, _ := procGetCurrentThreadId.Call()
	fmt.Printf("  targetThread=%d, curThread=%d\n", targetThread, curThread)

	if curThread != targetThread {
		r, _, _ = procAttachThreadInput.Call(curThread, targetThread, 1)
		fmt.Printf("  AttachThreadInput(attach) → %d\n", r)
	} else {
		fmt.Println("  Skipped (same thread)")
	}

	// Step 3: ShowWindow SW_RESTORE
	fmt.Println()
	fmt.Println("--- Step 3: ShowWindow SW_RESTORE ---")
	r, _, _ = procShowWindow.Call(hwnd, uintptr(SW_RESTORE))
	fmt.Printf("  ShowWindow(SW_RESTORE) → %d\n", r)

	// Step 4: SetForegroundWindow
	fmt.Println()
	fmt.Println("--- Step 4: SetForegroundWindow ---")
	r, _, _ = procSetForegroundWindow.Call(hwnd)
	fmt.Printf("  SetForegroundWindow() → %d (0=fail, non-zero=ok)\n", r)

	// Step 5: BringWindowToTop
	fmt.Println()
	fmt.Println("--- Step 5: BringWindowToTop ---")
	r, _, _ = procBringWindowToTop.Call(hwnd)
	fmt.Printf("  BringWindowToTop() → %d\n", r)

	// Step 6: DetachThreadInput
	if curThread != targetThread {
		r, _, _ = procAttachThreadInput.Call(curThread, targetThread, 0)
		fmt.Printf("  AttachThreadInput(detach) → %d\n", r)
	}

	fmt.Println()
	fmt.Println("=== 完成。检查目标窗口是否已置前 ===")
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("用法: debug_showwin.exe <PID>")
		fmt.Println("示例: debug_showwin.exe 34404")
		os.Exit(1)
	}

	// 解析 PID
	var pid uint32
	fmt.Sscanf(os.Args[1], "%d", &pid)
	fmt.Printf("诊断 PID: %d (%s)\n\n", pid, getProcessName(pid))

	// 路径 1：控制台
	consoleHwnd, err := tryConsoleApproach(pid)
	if err == nil {
		_ = consoleHwnd
		fmt.Println("(路径 1 成功，不执行路径 2)")
		return
	}
	fmt.Printf("路径 1 失败: %v\n", err)

	// 路径 2：进程树回溯
	fmt.Println()
	fmt.Println("=== 路径 2: findWindowForPID (进程树回溯) ===")
	fmt.Printf("从 PID=%d (%s) 开始向上追溯...\n", pid, getProcessName(pid))

	hwnd, title := findWindowForPID(pid)
	if hwnd == 0 {
		fmt.Println("❌ findWindowForPID 返回 0，未找到窗口")
		os.Exit(1)
	}

	fmt.Printf("\n✓ 找到目标窗口: hwnd=0x%x title=%q\n", hwnd, title)

	// 尝试置前
	tryBringToFront(hwnd)
}
