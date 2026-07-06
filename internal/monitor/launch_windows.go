//go:build windows

package monitor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

// resolveClaudePath 预检 claude 可执行文件是否可用（仅用于启动前的错误提示）。
// 优先级：exec.LookPath("claude") → LookPath("claude.exe") → 复用现有运行实例的 exe 路径
// （排除 Claude 桌面版）。实际启动命令统一用命令名 "claude"（交给 PowerShell 的 PATH 解析），
// 不传本函数返回的路径——避免路径含空格（如 C:\Users\PIE TK\...）时引号被剥离导致解析失败。
func resolveClaudePath() (string, error) {
	if p, err := exec.LookPath("claude"); err == nil {
		return p, nil
	}
	if p, err := exec.LookPath("claude.exe"); err == nil {
		return p, nil
	}
	// 回退：从任一存活的 Claude Code 实例取 exe 路径
	for _, proc := range enumerateClaudeProcesses() {
		exe := queryFullProcessImageName(uint32(proc.pid))
		if exe != "" && !strings.Contains(strings.ToLower(exe), `\anthropicclaude\`) {
			return exe, nil
		}
	}
	return "", fmt.Errorf("未找到 claude 可执行文件，请确认已安装 Claude Code（npm i -g @anthropic-ai/claude-code）且在 PATH 中")
}

// buildClaudeArgs 根据当前设置构建 claude 命令行参数。
// LaunchYolo=true 时附加 --permission-mode bypassPermissions（等价于 claude.yolo）。
func buildClaudeArgs() string {
	if GetSettings().LaunchYolo {
		return "claude --permission-mode bypassPermissions"
	}
	return "claude"
}

// resolveShell 返回系统默认可用的 PowerShell 可执行文件名，供启动终端实例使用。
// 不写死版本以适配各人环境：优先 PowerShell 7+（pwsh，更现代、默认 RemoteSigned 不弹签名确认），
// 回退 Windows PowerShell 5.1（powershell，Windows 内置必然存在）。
func resolveShell() string {
	if _, err := exec.LookPath("pwsh.exe"); err == nil {
		return "pwsh"
	}
	return "powershell"
}

// ResolveClaudePath 导出 resolveClaudePath，供内置终端解析 claude 路径（含运行实例枚举兜底）。
func ResolveClaudePath() (string, error) {
	return resolveClaudePath()
}

// BuildClaudeArgsForPTY 返回 claude 的额外命令行参数（不含可执行名），供内置终端拼接 cmdline。
// LaunchYolo=true 时附加 --permission-mode bypassPermissions。
func BuildClaudeArgsForPTY() string {
	if GetSettings().LaunchYolo {
		return "--permission-mode bypassPermissions"
	}
	return ""
}

// ResolveShellExe 返回系统默认 shell 的绝对路径（pwsh 优先，回退 powershell）。
// 供内置终端 shell tab 使用——CreateProcessW 不自动搜 PATH，需要绝对路径。
func ResolveShellExe() string {
	if p, err := exec.LookPath("pwsh.exe"); err == nil {
		return p
	}
	if p, err := exec.LookPath("powershell.exe"); err == nil {
		return p
	}
	return "powershell.exe"
}

// LaunchClaudeInDir 在 workdir 启动 claude，按 mode 决定终端窗口显示方式：
//   - "show"：可见窗口
//   - 默认（"hide"/"minimize"）：最小化窗口到任务栏（不抢焦点，可点击查看）
//
// show 和 hide 走完全相同的终端选择逻辑（优先 Windows Terminal，回退 PowerShell 控制台），
// 唯一区别是窗口初始是否最小化。
//
// 终端使用 PowerShell（而非 cmd），claude 启动参数由 buildClaudeArgs 控制。
// 返回终端描述（供前端反馈）。
func LaunchClaudeInDir(workdir string, mode string) (string, error) {
	if strings.TrimSpace(workdir) == "" {
		return "", fmt.Errorf("工作目录不能为空")
	}
	info, err := os.Stat(workdir)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("工作目录不存在或不是目录: %s", workdir)
	}
	abs, err := filepath.Abs(workdir)
	if err != nil {
		abs = workdir
	}
	// 预检 claude 是否可用（给出清晰错误，不启动）
	if _, err := resolveClaudePath(); err != nil {
		return "", err
	}

	minimized := mode != "show"
	return launchClaude(abs, minimized)
}

// launchClaude 统一启动逻辑：优先 Windows Terminal（用户配置的主题配色，与右键"打开终端"一致），
// 回退经典 PowerShell 控制台。minimized 仅控制窗口初始状态，不影响终端选择。
func launchClaude(abs string, minimized bool) (string, error) {
	claudeArgs := buildClaudeArgs()
	shell := resolveShell()
	cleanEnv := CleanEnvSlice() // 干净环境，避免继承本进程可能被污染的 env（如 MSYS bash 的 HOME）

	// 优先 Windows Terminal：与用户右键"打开终端"体验一致
	if wt, err := exec.LookPath("wt.exe"); err == nil {
		if !minimized {
			// 直接启动 wt.exe，简单可靠
			// -- 分隔 wt 选项与命令；CREATENEWPROCESSGROUP 防止 Ctrl+C 波及辅助进程
			// -ExecutionPolicy Bypass 跳过执行策略提示
			cmd := exec.Command(wt, "-d", abs, "--", shell, "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", claudeArgs)
			if cleanEnv != nil {
				cmd.Env = cleanEnv
			}
			cmd.SysProcAttr = &syscall.SysProcAttr{
				CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
			}
			if err := cmd.Start(); err == nil {
				return "Windows Terminal", nil
			}
		} else {
			// 最小化：先正常启动 wt.exe，再通过 Win32 ShowWindow 最小化窗口。
			// 不能按 PID 追踪 —— wt.exe 是轻量 launcher，实际窗口由
			// WindowsTerminal.exe（另一个进程）创建。
			// 改用窗口类名 diff：启动前快照现有 CASCADIA 窗口，启动后只最小化新窗口。
			existing := enumerateCascadiaWindows()
			cmd := exec.Command(wt, "-d", abs, "--", shell, "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", claudeArgs)
			if cleanEnv != nil {
				cmd.Env = cleanEnv
			}
			cmd.SysProcAttr = &syscall.SysProcAttr{
				CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
			}
			if err := cmd.Start(); err == nil {
				go minimizeNewCascadiaWindow(existing)
				return "Windows Terminal", nil
			}
		}
		// wt.exe 存在但启动失败 → 回退经典控制台
	}

	// 回退：经典 PowerShell 控制台（conhost.exe，默认蓝色背景）
	windowStyle := "Normal"
	if minimized {
		windowStyle = "Minimized"
	}
	return startPowerShell(abs, windowStyle)
}

// ---- Windows Terminal 最小化辅助（Win32 API）----

const cascadiaClass = "CASCADIA_HOSTING_WINDOW_CLASS"

// isCascadiaWindow 判断窗口是否为 Windows Terminal 主窗口。
func isCascadiaWindow(hwnd uintptr) bool {
	var buf [64]uint16
	procGetClassNameW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), 64)
	for i, c := range cascadiaClass {
		if buf[i] != uint16(c) {
			return false
		}
	}
	return buf[len(cascadiaClass)] == 0 // null 终止符
}

// enumerateCascadiaWindows 返回当前所有可见 CASCADIA 窗口句柄集合（用于 diff 出新窗口）。
func enumerateCascadiaWindows() map[uintptr]bool {
	set := make(map[uintptr]bool)
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		if isCascadiaWindow(hwnd) {
			vis, _, _ := procIsWindowVisible.Call(hwnd)
			if vis != 0 {
				set[hwnd] = true
			}
		}
		return 1 // TRUE，继续枚举
	})
	procEnumWindows.Call(cb, 0)
	return set
}

// minimizeNewCascadiaWindow 等待并最小化不在 existing 中的新 CASCADIA 窗口。
//
// 两阶段策略：
//  1. 轮询 EnumWindows 找到新出现的 CASCADIA 窗口（最多 2 秒）
//  2. 反复 SW_MINIMIZE —— Windows Terminal（WinUI 3）在初始化期间会自行
//     ShowWindow(SW_RESTORE) 覆盖外部最小化，单次调用不够，需多次锤击直到它稳定。
//
// 若始终未找到窗口则静默放弃（不影响启动结果）。
func minimizeNewCascadiaWindow(existing map[uintptr]bool) {
	// Phase 1: 找到新窗口
	var target uintptr
	for range 20 {
		time.Sleep(100 * time.Millisecond)
		cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
			if !existing[hwnd] && isCascadiaWindow(hwnd) {
				vis, _, _ := procIsWindowVisible.Call(hwnd)
				if vis != 0 {
					target = hwnd
					return 0 // FALSE，停止枚举
				}
			}
			return 1 // TRUE，继续枚举
		})
		procEnumWindows.Call(cb, 0)
		if target != 0 {
			break
		}
	}
	if target == 0 {
		return
	}

	// Phase 2: 反复最小化，对抗 WT 自恢复（最多 5 轮，每轮 400ms）
	const SW_MINIMIZE = 6
	for range 5 {
		procShowWindow.Call(target, uintptr(SW_MINIMIZE))
		time.Sleep(400 * time.Millisecond)
		vis, _, _ := procIsWindowVisible.Call(target)
		if vis == 0 {
			return // 仍然最小化，成功
		}
	}
}

// startPowerShell 在 abs 目录启动新的 PowerShell 窗口运行 claude。
// windowStyle: PowerShell Start-Process 的 -WindowStyle 参数值（Normal / Minimized）。
// 路径中的单引号会被转义，防止 PowerShell 注入。
func startPowerShell(abs string, windowStyle string) (string, error) {
	claudeArgs := buildClaudeArgs()
	escapedPath := strings.ReplaceAll(abs, "'", "''")
	shell := resolveShell()

	// Start-Process 启动新 PowerShell 窗口；-NoExit 保持窗口不关闭
	// shell 由 resolveShell() 决定（pwsh 优先，回退 powershell），适配各人环境，不写死版本。
	// -ExecutionPolicy Bypass 跳过执行策略提示（详见 launchVisible 注释）：
	// 内层 ArgumentList 是实际运行 claude 的窗口；外层是执行 Start-Process 的辅助进程。
	// 两处都加，否则任一处卡在"不可信发布者"确认框，claude 都无法启动。
	psCmd := fmt.Sprintf(
		"Start-Process -FilePath %s -WorkingDirectory '%s' -WindowStyle %s -ArgumentList '-ExecutionPolicy Bypass -NoExit -Command %s'",
		shell, escapedPath, windowStyle, claudeArgs,
	)
	cmd := exec.Command(shell, "-ExecutionPolicy", "Bypass", "-Command", psCmd)
	if env := CleanEnvSlice(); env != nil {
		cmd.Env = env // 外层 PowerShell 用干净 env；Start-Process 派生的内层窗口会继承
	}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("启动 PowerShell 失败: %w", err)
	}
	if windowStyle == "Minimized" {
		return "最小化窗口", nil
	}
	return "PowerShell", nil
}
