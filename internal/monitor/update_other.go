//go:build !windows && !darwin

package monitor

import "fmt"

// DownloadAndReplace 非 Windows/macOS 平台：不支持自动替换，返回错误提示用户手动下载。
func DownloadAndReplace(downloadURL, signature string, onProgress func(downloaded, total int64)) error {
	return fmt.Errorf("当前平台不支持自动更新，请手动下载: %s", downloadURL)
}
