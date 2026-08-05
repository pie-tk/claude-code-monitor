package monitor

import "testing"

func TestDarwinPlatformKey(t *testing.T) {
	got := darwinPlatformKey("arm64")
	if got != "darwin-arm64" {
		t.Errorf("darwinPlatformKey(arm64)=%q want darwin-arm64", got)
	}
}
