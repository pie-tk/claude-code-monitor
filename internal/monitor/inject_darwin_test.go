//go:build darwin

package monitor

import (
	"encoding/json"
	"testing"
)

func TestKeyTokenBytes(t *testing.T) {
	cases := []struct {
		key  string
		want string
	}{
		{"up", "\x1b[A"},
		{"down", "\x1b[B"},
		{"right", "\x1b[C"},
		{"left", "\x1b[D"},
		{"enter", "\r"},
		{"esc", "\x1b"},
		{"tab", "\t"},
		{"space", " "},
		{"backspace", "\x7f"},
		{"delete", "\x1b[3~"},
		{"ctrl+a", "\x01"},
		{"ctrl+u", "\x15"},
		{"ctrl+k", "\x0b"},
		{"clearInput", "\x15"}, // ctrl+u 清行
	}
	for _, c := range cases {
		got, ok := keyTokenBytes(c.key)
		if !ok {
			t.Errorf("keyTokenBytes(%q) 未识别", c.key)
			continue
		}
		if got != c.want {
			t.Errorf("keyTokenBytes(%q)=%q want %q", c.key, got, c.want)
		}
	}
}

func TestRenderAskTokens(t *testing.T) {
	actions := `[{"key":"down"},{"key":"enter"},{"text":"hi"}]`
	var toks []actionToken
	if err := json.Unmarshal([]byte(actions), &toks); err != nil {
		t.Fatal(err)
	}
	got, err := renderAskTokens(toks)
	if err != nil {
		t.Fatal(err)
	}
	want := "\x1b[B" + "\r" + "hi"
	if got != want {
		t.Errorf("renderAskTokens=%q want %q", got, want)
	}
}
