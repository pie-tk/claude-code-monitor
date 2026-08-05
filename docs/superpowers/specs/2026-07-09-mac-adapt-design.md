# cc-console macOS 适配设计

- 日期：2026-07-09
- 状态：已与用户逐节确认，待实现
- 目标平台：macOS（universal：arm64 + amd64）
- 源项目：Windows 专用，Wails v3 alpha + Go 1.26
- 实现分支：`tmp/ai-develop/binky/2026-07-09`

## 1. 背景与目标

cc-console 当前是 Windows 专用桌面工具（ConPTY 终端 / Win32 控制台注入 / Inno Setup 安装包）。本设计将其适配到 macOS，最终产出 universal DMG 安装包。

核心目标：

- macOS 上可运行、可监控本机 Claude Code 实例（数量/状态/模型/上下文）
- 实时数据桥接（statusline → slhook → `~/.cc-console/{live,hook,ask}/<pid>.json`）
- 内嵌终端（xterm.js + PTY）+ 内嵌实例命令注入（clear/rewind/prompt/ask）
- 外部终端注入（尽力而为，非保证）
- universal DMG（ad-hoc 签名）

## 2. 关键决策（已与用户确认）

| 决策项 | 选择 | 说明 |
|---|---|---|
| 功能深度 | 全功能对齐 | 含内嵌终端/注入 + 外部注入尽力而为 |
| DMG 签名 | ad-hoc | `codesign --sign -`，零成本，首次 `xattr -cr` 放行 |
| CPU 架构 | universal | arm64 + amd64 lipo 合并，一个 DMG 覆盖所有 Mac |
| 实现策略 | 一次性全功能 | 所有层一起实现，最后出全功能 DMG |

## 3. 关键技术事实

- **macOS 上 claude 是 node 进程**：claude CLI 装在 nvm（`~/.nvm/.../bin/claude`），实际是 node 脚本。运行 `claude` → 进程是 `node`，命令行含 claude 的 js 入口路径。检测必须按**命令行**匹配，不能用进程名 `claude.exe`。
- **排除 Claude Desktop.app**：`/Applications/Claude.app` 是 Electron，命令行不同，须排除。
- **前端产物已 embed 进 binary**：`app.go:16` `//go:embed all:frontend/dist` → `.app` 无需单独带 dist。
- **纯 Go 无 cgo**：用 `exec.Command` 调系统命令（`ps`/`lsof`/`pgrep`/`defaults`/`osascript`），利于 universal 交叉编译。
- **Wails v3 无内置 DMG 任务**：手动构造 `.app` bundle + `hdiutil`。
- **macOS 无 ConPTY 等价**：外部终端注入受限（详见第 7 节）。
- 本机环境：Apple Silicon arm64；Node 25 / npm 11 / Xcode CLT / claude 2.1.205 / hdiutil / iconutil / sips / Homebrew 齐备；**Go 未装**（构建前需 `brew install go`）。

## 4. 总体架构

沿用项目既有的 build tag 隔离架构，**替换 darwin 存根为真实实现**，前端基本不动（`Call.ByID` + 硬编码 ID 平台无关）。

**build tag 策略**：

- darwin 专属能力（osascript / defaults / LaunchAgent）：走 `_darwin.go`
- unix 通用能力（ps / lsof / creack/pty）：走 `!windows` 文件覆盖（linux 顺便也通，无害）
- 新增 `_darwin.go` 时，对应 `!windows` 存根 tag 收窄为 `!windows && !darwin`，避免同平台重复定义

**新增依赖**：`github.com/creack/pty`（内嵌终端，纯 Go，支持 darwin/linux）。

## 5. 数据获取层

### 5.1 进程检测（detector_darwin.go，重写存根）

`init()` 赋值四个函数变量：

- `enumerateClaude()`：`ps -ax -o pid,command` 全量，过滤「node + 命令行含 `claude`」，排除 Claude Desktop.app 路径，返回 `[]claudeProc{pid, createMs}`。createMs 由 `ps -o lstart=` 解析（容差 15s，沿用既有判定）。
- `procCwd(pid)`：`lsof -a -p <pid> -d cwd -Fn` 读 cwd 行。
- `isProcessAlive(pid, startedAt)`：`os.FindProcess` + `signal(syscall.Signal(0))` 探活 + 启动时间匹配（防 pid 复用）。
- `enumerateChildren(claudePids)`：`pgrep -P <pid>` 查子进程（busy 判定）。
- `processCmdline(pid)`（bridge_other.go）：`ps -o command= -p <pid>`，供 `isNonInteractive`（过滤 doctor/mcp serve/--version）和 `hasToolChild` 用。

**性能**：每秒一次 `ps -ax`（典型 <50ms）+ 若干 `lsof`/`pgrep`，可接受。后续若瓶颈再换 `proc_listpids`+cgo。

### 5.2 桥接主逻辑（bridge.go，改）

平台无关 I/O + settings.json 操作不动。改：`slhookExeName`/`hookCommandTag` 从常量 `"cc-console-sl.exe"` 改为按 `runtime.GOOS`（darwin → `"cc-console-sl"`），`EnsureBridge` 的存在性检查路径随之正确。

### 5.3 slhook helper（cmd/slhook/）

- **bridge.mjs** L29：spawn 名按 `process.platform`（darwin → `cc-console-sl`，无 .exe）。其余（读 stdin、链式原 statusLine、`windowsHide`）跨平台已就绪。
- **proctree_darwin.go**（新增）：`findClaudePID()` 从自身 pid 起，`ps -o ppid= -p <pid>` 逐级向上走父链，对每个父进程查命令行是否含 `claude`，命中即返回。链路 `claude(node) → node bridge.mjs → cc-console-sl`，向上约 2 级命中。
  - build tag 收窄：`proctree_other.go` tag 改 `!windows && !darwin`。

### 5.4 数据流

```
claude(node) --statusline--> node bridge.mjs --spawn--> cc-console-sl
                                                              |
                  ~/.cc-console/live/<pid>.json  <-----------+  实时 token/上下文
                  ~/.cc-console/hook/<pid>.json  <-----------+  生命周期
                  ~/.cc-console/ask/<pid>.json   <-----------+  AskUserQuestion 挂起
                              |
   detector.Detect() 每秒读取 ---> 前端展示
```

## 6. 内嵌终端 + 内嵌实例注入

### 6.1 内嵌终端（pty_unix.go，替换 pty_other.go）

用 `github.com/creack/pty`。build tag `!windows`（darwin+linux 通用），文件重命名 `pty_other.go` → `pty_unix.go`。

```go
type ptySession struct {
    id, kind, workdir string
    master *os.File
    cmd    *exec.Cmd
}
```

- `StartPTYSession`：kind=claude → `claude`（LookPath）；kind=shell → `$SHELL` 或 `/bin/zsh`。`cmd.Dir=workdir`，`cmd.Env=os.Environ()`（macOS 无需 CleanEnv）。`pty.StartWithSize(cmd, &winsize)` 启动；goroutine 阻塞读 master → emit `term:output`（unix 下子进程退出后 master 读到 EOF，自然结束，**无需 Windows 那套 PeekNamedPipe 轮询**）；goroutine `cmd.Wait()` → emit `term:exit`。
- `Write`（master.Write）/ `Resize`（`pty.Setsize`）/ `Kill`（`Process.Kill`）。
- `ConPTYSupported() bool { return true }`。

### 6.2 内嵌实例命令注入（inject_darwin.go，重写存根）

**关键**：内嵌实例我们持有 PTY master fd，可直接写字节——这是 macOS 上**唯一可靠的注入路径**。

inject_darwin.go 通过包级 `ptyRegistry` 反查 pid（registry 启动时记录 `pid → sessionId`）：

- 命中内嵌 → 写 PTY master：
  - `SendClear` → `/clear\r`；`SendRewind` → `/rewind\r`；`SendPrompt(text)` → `text\r`
  - `SendAskAnswer(actions)` → 方向键 ANSI（`\x1b[A/B`）+ `\r`，对齐 Windows 版选项语义
  - `ShowWindow` → emit 事件让前端激活对应 xterm tab
  - `CloseInstance` → `ptyRegistry.Kill`
- 未命中（外部终端）→ 走第 7 节外部注入（尽力而为）

### 6.3 service 层适配（monitor_service.go，改）

- `buildClaudeCmdline`/`buildTerminalCmdline`：加 darwin 分支（`claude` LookPath / `$SHELL`，不走 .cmd/.exe/APPDATA）。
- `LaunchInstance`：embedded 且 `ConPTYSupported()` → 内嵌 PTY；否则外部 Terminal。
- `StartTerminal`/`WriteTerminal`/`ResizeTerminal`/`KillTerminal`：走 PTYRegistry（平台无关接口，macOS 实现就绪即通）。

## 7. 外部终端注入（尽力而为 · 非保证）

### 7.1 局限

macOS 无 ConPTY 等价机制：没有全局控制台输入队列可挂载；写 `/dev/ttys*` 是写**输出**（显示）非注入输入；`TIOCSTI` ioctl 能注入输入队列，但 macOS 受 SIP 限制，非 root 基本不可用（Apple 计划废弃）。所以对外部已运行 claude（Terminal.app/iTerm2 里），**可靠注入基本做不到**。本节是尽力而为。

### 7.2 双策略（按优先级回退）

**策略 A · AppleScript（限 Terminal.app）**

- `osascript -e 'tell application "Terminal" to do script "<cmd>" in selected tab of front window'`
- 局限：① 只对 Terminal.app（iTerm2/VSCode 终端无效）；② `do script` 是新开命令非注入现有 claude 输入；③ 需 claude 在前台 tab。
- 适用：`ShowWindow`（activate Terminal，**较可靠**）；`SendPrompt` 勉强（会变成在 tab 执行命令，可能干扰）；其余基本无效。

**策略 B · TIOCSTI（通用但受限）**

- `lsof` 探测 claude 的 controlling tty → `unix.IoctlSetInt(fd, TIOCSTI, ...)` 逐字节注入。
- 局限：macOS SIP 下非 root 大概率 `EPERM`。默认预期失败。

### 7.3 降级与前端表现

- 所有外部注入 try/catch，失败返回明确错误（如「外部终端注入仅支持 Terminal.app 且不稳定，建议改用内嵌实例」）。
- 前端已有统一降级（`alert`），不影响其他功能。
- 设置页引导：「为获得完整注入能力，请用内嵌实例启动」。
- `ShowWindow` 外部走 activate（Terminal/iTerm2 分支），不报错。

## 8. 辅助功能 + 前端改动

### 8.1 启动实例（launch_darwin.go 新增；launch_other.go tag 收窄 `!windows && !darwin`）

- `ResolveClaudePath()`：`exec.LookPath("claude")`，排除 `/Applications/Claude.app`。
- `LaunchClaudeInDir(dir)`：`osascript -e 'tell app "Terminal" to do script "cd \"<dir>\" && claude"'`。iTerm2 可选支持（检测 `com.googlecode.iterm2`）。
- `ResolveShellExe()`：`$SHELL` → `/bin/zsh` → `/bin/bash`。

### 8.2 开机自启（settings_darwin.go 新增；settings_default.go tag 收窄）

LaunchAgent 写 `~/Library/LaunchAgents/local.cc-console.plist`（`RunAtLoad=true`，`ProgramArguments` = `open -a cc-console`）。`SetAutoStart(true)` 写 plist + `launchctl load`；`(false)` unload + 删 plist；`IsAutoStartEnabled()` 查 plist 存在。**自启打开已安装 .app，需 DMG 安装后才生效**。

### 8.3 暗色模式（theme/detect_darwin.go，重写存根）

`defaults read -g AppleInterfaceStyle` → 输出含 `Dark` 为暗色；键不存在（未改过外观）= light。

### 8.4 浏览器打开（settings_browser.go，改）

加 `runtime.GOOS=="darwin"` 分支 → `open <url>`；linux 保留 `xdg-open`；windows 保留 rundll32。

### 8.5 自动更新（update.go 改 + update_darwin.go 新增）

- update.go platform key 从硬编码 `windows-x86_64` 改为按运行时 `GOOS-GOARCH`（`darwin-universal` 等）。
- update_darwin.go `DownloadAndReplace`：下 dmg 到临时目录 → `open` 挂载 → 提示「拖到 Applications 替换」（macOS 无法静默替换 .app）。
- latest.json 的 darwin 资产条目属发布流程，本次只做客户端读取适配。

### 8.6 前端改动（main.js / index.html，小改）

- `openNewTerminal`（main.js:4582）：mac 用 `"shell"`（zsh），去掉 cmd 尝试；失败提示「未找到 zsh/bash」。
- index.html 文案：tooltip「PowerShell，失败回退 CMD」→「终端（zsh/bash）」；注释 ConPTY → PTY。
- xterm fontFamily 已含 Menlo，mac 无害；路径处理（`replace(/\\/g,'/')`、basename）对正斜杠路径天然兼容，不改。

## 9. 打包交付

### 9.1 app.go Mac 选项（改）

当前 `application.Options` 只有 `Windows` 字段。补 `Mac` 选项（如 `application.MacOptions{ActivationPolicy: application.ActivationPolicyRegular}`，字段名按 Wails v3 alpha API 确认），让 app 显示在 Dock + 菜单栏，否则像后台 agent。系统托盘逻辑（已有）mac 兼容。

### 9.2 新增 build-mac.sh 流程

```
1. 前端构建      cd frontend && npm ci && npm run build && cd ..
2. 生成 icns     sips 多尺寸缩放 trayicon.png → iconset → iconutil -c icns → icons.icns
3. universal     GOARCH=arm64 + GOARCH=amd64 go build -ldflags="-s -w" → lipo 合并
                 (主程序 cc-console + slhook cc-console-sl 各做一次)
4. .app bundle   Contents/MacOS/cc-console
                 Contents/Resources/{cc-console-sl, bridge.mjs, icons.icns}
                 Contents/Info.plist
5. ad-hoc 签名   codesign --force --deep --sign - cc-console.app
6. 打 DMG        hdiutil create -volname cc-console -srcfolder .app -ov -format UDZO
                 → bin/cc-console-<ver>-universal.dmg
```

### 9.3 Info.plist 要点

`CFBundleName=cc-console`、`CFBundleIdentifier=local.cc-console`、`CFBundleExecutable=cc-console`、`CFBundleIconFile=icons`、`CFBundleShortVersionString=<Version>`、`LSMinimumSystemVersion=11.0`、`NSHighResolutionCapable=true`。

### 9.4 slhook/bridge.mjs 定位（关键）

bridge.mjs spawn **同目录**的 `cc-console-sl`。`.app` 内两者都在 `Contents/Resources` ✓。`settings.json` 的 statusLine 由 EnsureBridge 写入，指向运行 binary 旁的 bridge.mjs 绝对路径（`/Applications/cc-console.app/Contents/Resources/bridge.mjs`）。

## 10. 完整文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `internal/monitor/detector_darwin.go` | 重写 | `ps` 枚举 claude(node) + `lsof` 读 cwd + 存活/创建时间 |
| `internal/monitor/bridge_other.go` | 改 | `processCmdline` 用 `ps -o command=`（unix 通用） |
| `internal/monitor/bridge.go` | 改 | `slhookExeName`/`hookCommandTag` 按平台（darwin 无 .exe） |
| `cmd/slhook/bridge.mjs` | 改 | spawn 名 → `cc-console-sl` |
| `cmd/slhook/proctree_darwin.go` | 新增 | `findClaudePID` 沿 ppid 链找 claude(node) |
| `cmd/slhook/proctree_other.go` | 改 tag | 收窄 `!windows && !darwin` |
| `internal/monitor/pty_other.go` → `pty_unix.go` | 重写 | `creack/pty` 实现（darwin+linux） |
| `internal/monitor/inject_darwin.go` | 重写 | 内嵌实例写 PTY master + 外部注入尽力而为 |
| `internal/monitor/launch_darwin.go` | 新增 | `LookPath("claude")` + osascript 开 Terminal |
| `internal/monitor/launch_other.go` | 改 tag | 收窄 `!windows && !darwin` |
| `internal/monitor/settings_darwin.go` | 新增 | LaunchAgent 开机自启 |
| `internal/monitor/settings_default.go` | 改 tag | 收窄 `!windows && !darwin` |
| `internal/theme/detect_darwin.go` | 重写 | `defaults read -g AppleInterfaceStyle` |
| `internal/monitor/settings_browser.go` | 改 | darwin 用 `open` |
| `internal/monitor/update.go` | 改 | platform key 按 GOOS/GOARCH |
| `internal/monitor/update_darwin.go` | 新增 | 下载 dmg + 提示打开 |
| `service/monitor_service.go` | 改 | `buildTerminalCmdline`/`buildClaudeCmdline` 加 darwin 分支 |
| `app.go` | 改 | 补 `Mac` 选项（ActivationPolicy Regular） |
| `build-mac.sh` | 新增 | universal build + .app bundle + ad-hoc + DMG |
| `frontend/src/main.js` | 小改 | `openNewTerminal` kind → shell；文案 |
| `frontend/index.html` | 小改 | 文案通用化 |
| `go.mod` | 改 | 新增 `github.com/creack/pty` |

## 11. 前置阻塞处理（实现前）

1. **Go 未装** → `brew install go`（项目需 Go 1.26+）。
2. **creack/pty 依赖** → `go get github.com/creack/pty`。
3. **分支** → `tmp/ai-develop/binky/2026-07-09`（已切换）。

## 12. 验收清单

- [ ] `bin/cc-console-<ver>-universal.dmg` 生成，`lipo -info` 显示 universal（arm64+amd64）
- [ ] 双击 dmg → 拖装 → `xattr -cr` → 启动正常（Dock 有图标 + 菜单栏）
- [ ] 内嵌 claude 实例：监控 + clear/rewind/prompt/ask 注入可用
- [ ] 状态栏桥接：`~/.cc-console/{live,hook,ask}/<pid>.json` 正常写入
- [ ] 开机自启 LaunchAgent、暗色模式、浏览器打开、更新检查均工作
- [ ] 外部终端实例：ShowWindow 可 activate（其余尽力而为，失败优雅降级）

## 13. 风险与降级

- **外部注入**：非保证。失败时前端 alert 降级 + 设置页引导用内嵌实例。不影响其他功能。
- **ps/lsof 性能**：若每秒全量 ps 成为瓶颈，换 `proc_listpids`+cgo（会引入 cgo，影响 universal 交叉编译，作为最后手段）。
- **Wails v3 alpha API**：`Mac` 选项字段名、托盘 API 可能在 alpha 版有差异，实现时按实际 API 确认。
- **creack/pty 依赖**：`go get` 需网络；若代理受限，预下载 vendor。
- **AppleScript 权限**：首次 osascript 控制 Terminal.app 可能触发系统授权弹窗，属正常。
