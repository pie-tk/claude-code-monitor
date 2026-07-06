package main

import (
	"embed"
	"fmt"
	"time"

	"cc-console/internal/crashlog"
	"cc-console/internal/monitor"
	"cc-console/service"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend/dist
var assets embed.FS

// runWailsApp 启动 Wails GUI 应用。
func runWailsApp() {
	svc := service.NewMonitorService()

	app := application.New(application.Options{
		Name:        "CC Console",
		Description: "实时监控本机运行中的所有 Claude Code 实例",
		Icon:        trayIconBytes,
		Services: []application.Service{
			application.NewService(svc),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "cc-console-ebc9d7a2",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				// 第二个实例启动时，显示已有窗口
				win := svc.GetWindow()
				if win != nil {
					win.Show()
					win.Focus()
				}
			},
		},
		Windows: application.WindowsOptions{
			DisableQuitOnLastWindowClosed: true, // 关闭窗口不退出，托盘控制退出
		},
	})

	// 读取已保存的窗口几何，恢复用户上次的缩放大小（无记录或损坏时用默认值）
	geo := monitor.GetWindowGeometry()
	winOpts := application.WebviewWindowOptions{
		Title:                      "CC Console",
		Width:                      1442,
		Height:                     960,
		MinWidth:                   660,
		MinHeight:                  420,
		BackgroundColour:           application.NewRGB(255, 255, 255),
		DefaultContextMenuDisabled: true,
		URL:                        "/",
	}
	if geo.Ok && !geo.Maximised {
		winOpts.Width = geo.Width
		winOpts.Height = geo.Height
	}
	win := app.Window.NewWithOptions(winOpts)
	if geo.Ok && geo.Maximised {
		win.Maximise() // 上次是最大化：直接最大化，避免先用全屏尺寸创建再拉伸的闪烁
	}

	svc.SetApp(app, win)

	// ---- 系统托盘 ----
	tray := app.SystemTray.New()
	tray.SetIcon(trayIconBytes)
	tray.SetTooltip("CC Console")

	// 单击托盘图标 = 显示窗口
	tray.OnClick(func() {
		win.Show()
		win.Focus()
	})

	menu := app.NewMenu()
	menu.Add("显示窗口").OnClick(func(ctx *application.Context) {
		win.Show()
		win.Focus()
	})
	menu.AddSeparator()
	menu.Add("退出").OnClick(func(ctx *application.Context) {
		quitApp(svc, app)
	})
	tray.SetMenu(menu)

	// ---- 关闭窗口：根据设置决定隐藏到托盘还是直接退出 ----
	win.RegisterHook(events.Common.WindowClosing, func(event *application.WindowEvent) {
		if monitor.IsCloseQuit() {
			quitApp(svc, app)
			return
		}
		win.Hide()
		event.Cancel()
	})

	// ---- 窗口缩放记忆：拖动边缘调整大小后防抖保存，下次启动恢复 ----
	// 注意：窗口事件回调运行在主线程，win.Width() 内部是 InvokeSync（主线程同步），
	// 若直接在回调里调用会造成主线程重入死锁；改用 time.AfterFunc 把取值放到独立 goroutine。
	var geoTimer *time.Timer
	win.RegisterHook(events.Common.WindowDidResize, func(event *application.WindowEvent) {
		if geoTimer != nil {
			geoTimer.Stop()
		}
		geoTimer = time.AfterFunc(400*time.Millisecond, func() {
			w, h := win.Width(), win.Height()
			if w == 0 || h == 0 {
				return // 窗口已销毁（退出流程中），丢弃脏值避免覆盖上次尺寸
			}
			monitor.UpdateWindowGeometry(w, h, win.IsMaximised())
		})
	})

	// ---- 定时更新托盘 tooltip ----
	go func() {
		defer crashlog.Recover()
		for {
			live, stale, _ := monitor.Detect()
			busy := monitor.CountStatus(live, "busy")
			idle := monitor.CountStatus(live, "idle")
			tooltip := fmt.Sprintf("CC Console\n在线 %d (🔴 忙碌 %d · 🟢 空闲 %d)", len(live), busy, idle)
			if len(stale) > 0 {
				tooltip += fmt.Sprintf("\n残留 %d", len(stale))
			}
			tray.SetTooltip(tooltip)
			time.Sleep(2 * time.Second)
		}
	}()

	err := app.Run()
	if err != nil {
		fmt.Println("应用运行出错:", err)
	}
}

// quitApp 退出前清理所有内置终端会话（终止 claude/pwsh 子进程、释放 ConPTY 句柄），再退出应用。
func quitApp(svc *service.MonitorService, app *application.App) {
	svc.CloseAllTerminals()
	app.Quit()
}
