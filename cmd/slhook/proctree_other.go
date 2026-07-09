//go:build !windows && !darwin

package main

// 非 Windows 平台:statusline 桥接仅支持 Windows。stub 保证可编译。
func findClaudePID() int { return 0 }
