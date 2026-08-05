//go:build !windows

package monitor

import "testing"

func TestSessionByPIDEmptyRegistry(t *testing.T) {
	r := NewPTYRegistry()
	if id, ok := r.SessionByPID(12345); ok || id != "" {
		t.Fatalf("空注册表不应命中，got id=%q ok=%v", id, ok)
	}
}

func TestConPTYSupportedOnUnix(t *testing.T) {
	if !ConPTYSupported() {
		t.Fatal("unix 平台 ConPTYSupported 应为 true")
	}
}
