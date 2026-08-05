package main

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"cc-console/internal/crashlog"
	"cc-console/internal/monitor"
)

//go:embed icon.ico
var iconBytes []byte

//go:embed trayicon.png
var trayIconBytes []byte

func main() {
	monitor.LoadConfig()

	// statusline 桥接:确保 ~/.claude/settings.json 指向 slhook,以获取活跃会话的实时数据。
	// 失败不阻断启动(前端会显示"桥接未生效"提示)。
	if monitor.GetSettings().BridgeEnabled {
		if _, err := monitor.EnsureBridge(); err != nil {
			fmt.Fprintln(os.Stderr, "statusline 桥接初始化失败:", err)
		}
	}

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--list", "-l", "list":
			runList()
			return
		case "--restore-statusline":
			// 卸载时调用:把 ~/.claude/settings.json 的 statusLine 还原为桥接前的原命令
			if err := monitor.DisableBridge(); err != nil {
				fmt.Fprintln(os.Stderr, "还原 statusLine 失败:", err)
				os.Exit(1)
			}
			return
		case "-h", "--help", "help":
			fmt.Println("cc-console                  启动 GUI 监控窗口（系统托盘常驻，每 1 秒刷新）")
			fmt.Println("cc-console --list           以命令行表格形式打印一次后退出")
			return
		}
	}

	// GUI 路径：注入 darwin 登录 shell 的 PATH（解决 GUI 启动时 LookPath(claude)
	// 找不到 nvm/homebrew）。Windows 无此问题，函数内部按 runtime.GOOS 守卫。
	ensureDarwinPATH()

	// GUI 路径：初始化崩溃日志，捕获 panic / Go runtime fatal error 堆栈到
	// ~/.cc-console/logs/monitor.log。CLI --list 模式不重定向，保持终端输出正常。
	crashlog.Setup(monitorLogDir())
	defer crashlog.Recover()

	runWailsApp()
}

// monitorLogDir 返回应用日志目录 ~/.cc-console/logs（home 不可用时回退临时目录）。
func monitorLogDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(os.TempDir(), "cc-console", "logs")
	}
	return filepath.Join(home, ".cc-console", "logs")
}

func runList() {
	live, stale, err := monitor.Detect()
	if err != nil {
		fmt.Fprintln(os.Stderr, "检测出错:", err)
		os.Exit(1)
	}

	head := fmt.Sprintf("在线 Claude Code 实例: %d", len(live))
	if n := monitor.CountStatus(live, "busy") + monitor.CountStatus(live, "idle"); n > 0 {
		head += fmt.Sprintf("   (● 忙碌 %d   ○ 空闲 %d)", monitor.CountStatus(live, "busy"), monitor.CountStatus(live, "idle"))
	}
	fmt.Println(head)
	fmt.Println()
	fmt.Printf("%-7s  %-8s  %-12s  %-16s  %-8s  %-26s  %s\n",
		"PID", "状态", "模型", "Context", "本轮", "对话主题", "项目 (工作目录)")
	fmt.Println("------------------------------------------------------------------------------------------------------------------------")
	for _, it := range live {
		cwd := it.Cwd
		if cwd == "" {
			cwd = "(无 session 记录)"
		}
		if len([]rune(cwd)) > 34 {
			r := []rune(cwd)
			cwd = "..." + string(r[len(r)-31:])
		}
		topic := monitor.TopicDisplay(it)
		if len([]rune(topic)) > 26 {
			topic = monitor.TruncateRunes(topic, 25)
		}
		bridgeTag := ""
		if !it.BridgeConnected {
			bridgeTag = "  [未接入]"
		}
		fmt.Printf("%-7d  %-8s  %-12s  %-16s  %-8s  %-26s  %s%s\n",
			it.Pid, monitor.StatusText(it.Status), monitor.ModelDisplay(it),
			monitor.ContextDisplayPlain(it), monitor.OutputDisplay(it), topic, cwd, bridgeTag)
	}
	fmt.Println()
	fmt.Printf("合计 Context: %s", monitor.FormatTokens(monitor.TotalContext(live)))
	if len(stale) > 0 {
		fmt.Printf("    另有 %d 个残留会话（进程已退出）", len(stale))
	}
	fmt.Println()
}

// buildStatsLine 构建统计行文本（前端也会生成，此函数用于 CLI 和托盘 tooltip）。
func buildStatsLine(online, busy, idle int, totalCtx int64, stale int) string {
	if online == 0 {
		return "🌙  当前无实例运行"
	}
	parts := []string{
		fmt.Sprintf("在线 %d", online),
		fmt.Sprintf("🔴 %d 忙碌", busy),
		fmt.Sprintf("🟢 %d 空闲", idle),
	}
	if totalCtx > 0 {
		parts = append(parts, fmt.Sprintf("📦 %s context", monitor.FormatTokensCompact(totalCtx)))
	}
	if stale > 0 {
		parts = append(parts, fmt.Sprintf("🌓 %d 残留", stale))
	}
	return monitor.JoinWithDot(parts)
}

// unused keeps time import available for CLI mode
var _ = time.Sleep
