//go:build !windows

package monitor

import "testing"

func TestSlhookExeNameNoExeOnUnix(t *testing.T) {
	if slhookExeName == "cc-console-sl.exe" {
		t.Fatalf("非 Windows 平台 slhookExeName 不应带 .exe，实际: %s", slhookExeName)
	}
	if hookCommandTag == "cc-console-sl.exe" {
		t.Fatalf("非 Windows 平台 hookCommandTag 不应带 .exe，实际: %s", hookCommandTag)
	}
}
