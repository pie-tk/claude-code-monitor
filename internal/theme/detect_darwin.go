//go:build darwin

package theme

import "os/exec"

// IsSystemDarkMode 用 defaults read 检测 macOS 暗色模式。
// AppleInterfaceStyle 键仅在用户改过外观时存在；含 "Dark" 为暗色，不存在/其它 = light。
func IsSystemDarkMode() bool {
	out, err := exec.Command("defaults", "read", "-g", "AppleInterfaceStyle").Output()
	if err != nil {
		return false // 键不存在 = 未改过 = light
	}
	s := string(out)
	for _, k := range []string{"Dark", "dark"} {
		if containsStr(s, k) {
			return true
		}
	}
	return false
}

func containsStr(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
