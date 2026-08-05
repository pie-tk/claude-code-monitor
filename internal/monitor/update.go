package monitor

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// ReleaseInfo 最新版本信息（从 latest.json manifest 解析）。
type ReleaseInfo struct {
	Version     string `json:"version"`     // 如 "1.2.0"
	Name        string `json:"name"`        // release 标题
	Body        string `json:"body"`        // release notes (markdown)
	DownloadURL string `json:"downloadUrl"` // 安装包下载地址
	Signature   string `json:"signature"`   // minisign 签名文本（两行），下载后校验用
	PublishedAt string `json:"publishedAt"`
}

// minisignPublicKeyB64 是嵌入应用的 minisign 公钥（base64 编码的「两行公钥文本」）。
// 由 `minisign -G` 生成密钥对后，把 cc-console.pub 的两行内容整体做一次 base64
// 编码填入此处。私钥 cc-console.sec 绝不进仓库，仅本地用于发布签名。
const minisignPublicKeyB64 = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgODc2MDRFNENERkM4QzJDNg0KUldUR3dzamZURTVnaDBpczh5REo2U3kza1VId25acGxsVDVueWMyUGFxczFKemVuWm9NWThWUG4NCg=="

// manifestURL 指向最新 release 的 latest.json。
// 走 GitHub Release CDN（对象存储），不计入 REST API 速率限额（旧版调
// api.github.com 受未认证 60次/小时 限制）。该 URL 经 "latest" 重定向，只指向
// 非预发布 release —— 发布时务必用正式 release，否则重定向会指向更旧的正式版。
const manifestURL = "https://github.com/pie-tk/cc-console/releases/latest/download/latest.json"

// signingPublicKey 解码嵌入的 minisign 公钥，返回两行文本。
func signingPublicKey() (string, error) {
	b, err := base64.StdEncoding.DecodeString(minisignPublicKeyB64)
	if err != nil {
		return "", fmt.Errorf("嵌入的 minisign 公钥无效（请用 minisign -G 生成并填入）: %w", err)
	}
	return string(b), nil
}

// CheckLatestRelease 下载 latest.json 静态 manifest 获取最新版本信息。
// 走 GitHub Release CDN，不再调用受限的 REST API。
func CheckLatestRelease() (*ReleaseInfo, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest("GET", manifestURL, nil)
	if err != nil {
		return nil, fmt.Errorf("创建请求失败: %w", err)
	}
	req.Header.Set("User-Agent", "cc-console")

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("网络请求失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("获取 manifest 失败: HTTP %d", resp.StatusCode)
	}

	var m struct {
		Version   string `json:"version"`
		Notes     string `json:"notes"`
		PubDate   string `json:"pub_date"`
		Platforms map[string]struct {
			Signature string `json:"signature"`
			URL       string `json:"url"`
		} `json:"platforms"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		return nil, fmt.Errorf("解析 manifest 失败: %w", err)
	}

	key := currentPlatformKey()
	plat, ok := m.Platforms[key]
	if !ok {
		return nil, fmt.Errorf("manifest 缺少 %s 平台信息", key)
	}

	return &ReleaseInfo{
		Version:     strings.TrimPrefix(m.Version, "v"),
		Name:        m.Version,
		Body:        m.Notes,
		DownloadURL: plat.URL,
		Signature:   plat.Signature,
		PublishedAt: m.PubDate,
	}, nil
}

// currentPlatformKey 返回当前平台的 manifest 资产 key。
func currentPlatformKey() string {
	switch runtime.GOOS {
	case "darwin":
		return darwinPlatformKey(runtime.GOARCH)
	case "windows":
		return "windows-x86_64"
	}
	return runtime.GOOS + "-" + runtime.GOARCH
}

// darwinPlatformKey 生成 darwin 资产 key：darwin-arm64 / darwin-amd64。
// universal 发布可用 darwin-universal（此时由调用方覆盖 GOARCH）。
func darwinPlatformKey(arch string) string {
	return "darwin-" + arch
}

// IsNewer 比较两个语义化版本，latest > current 时返回 true。
func IsNewer(latest, current string) bool {
	lp := parseSemver(latest)
	cp := parseSemver(current)
	for i := 0; i < 3; i++ {
		if lp[i] > cp[i] {
			return true
		}
		if lp[i] < cp[i] {
			return false
		}
	}
	return false
}

// parseSemver 解析 "1.2.3" 为 [3]int，解析失败返回全 0。
func parseSemver(v string) [3]int {
	var parts [3]int
	n, _ := fmt.Sscanf(strings.TrimSpace(v), "%d.%d.%d", &parts[0], &parts[1], &parts[2])
	if n < 1 {
		return [3]int{}
	}
	return parts
}
