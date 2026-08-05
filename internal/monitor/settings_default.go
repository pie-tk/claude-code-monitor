//go:build !windows && !darwin

package monitor

// SetAutoStart 非 Windows/macOS 平台暂不支持。
func SetAutoStart(bool) error { return nil }

// IsAutoStartEnabled 非 Windows/macOS 平台暂不支持。
func IsAutoStartEnabled() (bool, error) { return false, nil }

// cleanupLegacyAutoStart 非 Windows/macOS 平台无需处理。
func cleanupLegacyAutoStart() {}
