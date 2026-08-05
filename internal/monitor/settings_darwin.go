//go:build darwin

package monitor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const launchAgentLabel = "local.cc-console"

func launchAgentPath() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

// launchAgentPlist 生成 LaunchAgent plist 内容。appPath 为 .app 路径或 binary 名称。
func launchAgentPlist(appPath string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>open</string>
		<string>-a</string>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key><true/>
</dict>
</plist>
`, launchAgentLabel, appPath)
}

// SetAutoStart 写入/移除 LaunchAgent。enable=true 安装，false 卸载。
func SetAutoStart(enable bool) error {
	path := launchAgentPath()
	if path == "" {
		return fmt.Errorf("无法定位 ~/Library/LaunchAgents")
	}
	if !enable {
		_ = exec.Command("launchctl", "unload", path).Run()
		_ = os.Remove(path)
		return nil
	}
	appPath := resolveAppPathForAutoStart()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(launchAgentPlist(appPath)), 0o644)
}

// IsAutoStartEnabled 检查 LaunchAgent plist 是否存在。
func IsAutoStartEnabled() (bool, error) {
	path := launchAgentPath()
	if path == "" {
		return false, nil
	}
	_, err := os.Stat(path)
	return err == nil, nil
}

// cleanupLegacyAutoStart macOS 无遗留自启项需清理。
func cleanupLegacyAutoStart() {}

// resolveAppPathForAutoStart 返回 .app 路径供 LaunchAgent 调用 open -a。
// 优先 /Applications/cc-console.app；否则从当前 binary 路径上溯定位 .app bundle
//（*.app/Contents/MacOS/<exe> 结构）；都不满足则回退 "cc-console"，由 open -a 走 PATH/Spotlight。
func resolveAppPathForAutoStart() string {
	candidate := "/Applications/cc-console.app"
	if info, err := os.Stat(candidate); err == nil && info.IsDir() {
		return candidate
	}
	// 从当前 binary 路径上溯找 .app bundle：结构为 <X>.app/Contents/MacOS/<exe>
	if exe, err := os.Executable(); err == nil {
		d := filepath.Clean(exe)
		for i := 0; i < 4 && d != "/" && d != "."; i++ {
			base := filepath.Base(d)
			// MacOS → 父目录是 Contents → 再上一层即 .app
			if base == "MacOS" {
				contents := filepath.Dir(d) // .../Contents
				appDir := filepath.Dir(contents)
				if strings.HasSuffix(appDir, ".app") {
					if info, err := os.Stat(appDir); err == nil && info.IsDir() {
						return appDir
					}
				}
				break
			}
			d = filepath.Dir(d)
		}
	}
	return "cc-console"
}
