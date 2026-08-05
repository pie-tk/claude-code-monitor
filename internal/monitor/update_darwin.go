//go:build darwin

package monitor

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// DownloadAndReplace 下载 dmg 并打开挂载（Finder 显示），提示用户拖拽到「应用程序」替换。
// macOS 无法像 Windows 那样静默替换运行中的 .app，故下载完成后交给用户手动安装。
//
// signature 在 macOS 更新路径不校验：dmg 由用户手动拖拽安装，minisign 静默校验意义有限；
// 参数保留以对齐 DownloadAndReplace 跨平台签名契约（service 层统一传 Signature）。
func DownloadAndReplace(downloadURL, signature string, onProgress func(downloaded, total int64)) error {
	tmp, err := os.MkdirTemp("", "cc-console-update")
	if err != nil {
		return fmt.Errorf("创建临时目录失败: %w", err)
	}
	dmgPath := filepath.Join(tmp, "cc-console.dmg")

	// 内联下载逻辑（与 update_windows.go 一致的 transport/CheckRedirect/onProgress 模式），
	// 不提取跨平台 downloadFile helper 以免迫使 Windows 版重构（超 scope）。
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 20 * time.Second}).DialContext,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   5 * time.Minute, // dmg 通常比 exe 大，放宽超时
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return fmt.Errorf("重定向次数过多")
			}
			req.Header.Del("Authorization")
			return nil
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return fmt.Errorf("创建下载请求失败: %w", err)
	}
	req.Header.Set("User-Agent", "cc-console")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("下载失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("下载失败: HTTP %d", resp.StatusCode)
	}

	minSize := int64(5 * 1024 * 1024)
	if resp.ContentLength > 0 && resp.ContentLength < minSize {
		return fmt.Errorf("文件大小异常 (%d bytes)，下载可能不完整", resp.ContentLength)
	}

	f, err := os.Create(dmgPath)
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}

	var written int64
	buf := make([]byte, 32*1024)
	lastPercent := -1
	total := resp.ContentLength
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			nw, writeErr := f.Write(buf[:n])
			if writeErr != nil {
				f.Close()
				os.RemoveAll(tmp) // 清理整个临时目录（含 dmg 文件），避免 orphan 目录
				return fmt.Errorf("写入文件失败: %w", writeErr)
			}
			written += int64(nw)
			if onProgress != nil && total > 0 {
				pct := int(written * 100 / total)
				if pct != lastPercent {
					lastPercent = pct
					onProgress(written, total)
				}
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			f.Close()
			os.RemoveAll(tmp) // 清理整个临时目录（含 dmg 文件），避免 orphan 目录
			return fmt.Errorf("读取下载流失败: %w", readErr)
		}
	}
	f.Close()

	if written < minSize {
		os.RemoveAll(tmp) // 清理整个临时目录（含 dmg 文件），避免 orphan 目录
		return fmt.Errorf("下载不完整: 仅收到 %.1f MB", float64(written)/(1024*1024))
	}

	if onProgress != nil {
		onProgress(written, written)
	}

	// 打开 dmg 挂载（Finder 显示），让用户拖到 Applications
	if err := exec.Command("open", dmgPath).Start(); err != nil {
		return fmt.Errorf("打开 dmg 失败: %w", err)
	}
	return fmt.Errorf("已下载并打开 dmg，请将 cc-console.app 拖到「应用程序」替换（macOS 需手动安装）")
}
