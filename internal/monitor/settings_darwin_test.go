//go:build darwin

package monitor

import "testing"

func TestLaunchAgentPlistContainsRunAtLoad(t *testing.T) {
	xml := launchAgentPlist("/Applications/cc-console.app")
	if !contains(xml, "<key>RunAtLoad</key>") {
		t.Fatal("plist 应含 RunAtLoad")
	}
	if !contains(xml, "open") {
		t.Fatal("plist 应含 open 命令")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
