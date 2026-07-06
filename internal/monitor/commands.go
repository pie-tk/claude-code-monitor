package monitor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// CommandSuggestion 是斜杠命令/技能自动补全列表中的一项。
type CommandSuggestion struct {
	Name        string `json:"name"`              // 如 clear / git-commit（不含前导 /）
	Type        string `json:"type"`              // builtin | command | skill
	Description string `json:"description"`       // 单行说明
	Source      string `json:"source"`            // 内置 / 项目 / 用户 / 插件
	ArgHint     string `json:"argHint,omitempty"` // 参数用法提示，如 [low|medium|high] [--fix]；补全选中后展示
}

// builtinCommands 是 Claude Code 内置斜杠命令清单（与终端 / 菜单一致）。
// 这些命令由 CLI 自身实现，不在磁盘上；放在最前，确保补全列表稳定可见。
//
// 清单按 Claude Code 2.1.201 实际 / 菜单逐项核对（已排除 user 自定义命令与 skill）。
// 注：内置命令随 CLI 版本迭代会增减，本表会随之漂移，升级后需复核。
var builtinCommands = []CommandSuggestion{
	// 会话与上下文
	{Name: "cd", Type: "builtin", Description: "切换当前会话的工作目录", Source: "内置"},
	{Name: "clear", Type: "builtin", Description: "清空上下文开启新会话（旧会话可 /resume 恢复）", Source: "内置"},
	{Name: "compact", Type: "builtin", Description: "压缩对话历史释放上下文", Source: "内置"},
	{Name: "resume", Type: "builtin", Description: "恢复之前的会话", Source: "内置"},
	{Name: "context", Type: "builtin", Description: "可视化当前上下文占用", Source: "内置"},
	{Name: "rewind", Type: "builtin", Description: "回溯代码/对话到之前的点", Source: "内置"},
	{Name: "fork", Type: "builtin", Description: "派生继承完整对话的后台代理", Source: "内置"},
	{Name: "rename", Type: "builtin", Description: "重命名当前会话", Source: "内置"},
	{Name: "recap", Type: "builtin", Description: "生成本次会话一行回顾", Source: "内置"},
	{Name: "copy", Type: "builtin", Description: "复制上一条回复到剪贴板（/copy N 取倒数第 N 条）", Source: "内置"},
	{Name: "export", Type: "builtin", Description: "导出当前会话到文件或剪贴板", Source: "内置"},
	// 模型与配置
	{Name: "model", Type: "builtin", Description: "设置模型", Source: "内置"},
	{Name: "config", Type: "builtin", Description: "打开设置", Source: "内置"},
	{Name: "theme", Type: "builtin", Description: "切换主题", Source: "内置"},
	{Name: "effort", Type: "builtin", Description: "设置模型推理强度", Source: "内置"},
	{Name: "fast", Type: "builtin", Description: "切换快速模式", Source: "内置"},
	{Name: "color", Type: "builtin", Description: "设置本次会话的提示栏颜色", Source: "内置"},
	{Name: "statusline", Type: "builtin", Description: "配置状态栏", Source: "内置"},
	{Name: "tui", Type: "builtin", Description: "设置终端 UI 渲染器", Source: "内置"},
	{Name: "keybindings", Type: "builtin", Description: "打开键盘快捷键文件", Source: "内置"},
	{Name: "plan", Type: "builtin", Description: "启用计划模式或查看会话计划", Source: "内置"},
	{Name: "focus", Type: "builtin", Description: "切换专注视图", Source: "内置"},
	{Name: "goal", Type: "builtin", Description: "设置停止前检查的目标", Source: "内置"},
	// 代理与扩展
	{Name: "plugin", Type: "builtin", Description: "管理插件", Source: "内置"},
	{Name: "hooks", Type: "builtin", Description: "查看钩子配置", Source: "内置"},
	{Name: "mcp", Type: "builtin", Description: "管理 MCP 服务器", Source: "内置"},
	{Name: "permissions", Type: "builtin", Description: "管理工具权限规则", Source: "内置"},
	{Name: "skills", Type: "builtin", Description: "列出可用技能", Source: "内置"},
	{Name: "reload-plugins", Type: "builtin", Description: "激活待生效的插件改动", Source: "内置"},
	{Name: "reload-skills", Type: "builtin", Description: "重新加载磁盘上新增/改动的技能", Source: "内置"},
	{Name: "tasks", Type: "builtin", Description: "查看与管理后台任务", Source: "内置"},
	{Name: "workflows", Type: "builtin", Description: "浏览运行中与已完成的 workflow", Source: "内置"},
	{Name: "loop", Type: "builtin", Description: "按间隔循环运行提示或斜杠命令", Source: "内置"},
	{Name: "ide", Type: "builtin", Description: "管理 IDE 集成", Source: "内置"},
	// 信息与项目
	{Name: "status", Type: "builtin", Description: "查看版本/模型/账号/API/工具状态", Source: "内置"},
	{Name: "usage", Type: "builtin", Description: "查看会话花费/套餐用量/活动统计", Source: "内置"},
	{Name: "doctor", Type: "builtin", Description: "诊断与校验安装和设置", Source: "内置"},
	{Name: "help", Type: "builtin", Description: "显示帮助与可用命令", Source: "内置"},
	{Name: "insights", Type: "builtin", Description: "生成会话分析报告", Source: "内置"},
	{Name: "debug", Type: "builtin", Description: "开启本次会话的调试日志", Source: "内置"},
	{Name: "memory", Type: "builtin", Description: "在编辑器打开记忆文件", Source: "内置"},
	{Name: "init", Type: "builtin", Description: "初始化项目的 CLAUDE.md", Source: "内置"},
	{Name: "diff", Type: "builtin", Description: "查看未提交改动与每轮 diff", Source: "内置"},
	{Name: "review", Type: "builtin", Description: "审查 GitHub PR（工作区 diff 用 /code-review）", Source: "内置"},
	// 账号与其他
	{Name: "login", Type: "builtin", Description: "登录 Anthropic 账号", Source: "内置"},
	{Name: "logout", Type: "builtin", Description: "登出账号", Source: "内置"},
	{Name: "mobile", Type: "builtin", Description: "显示下载移动 App 的二维码", Source: "内置"},
	{Name: "powerup", Type: "builtin", Description: "通过互动小课发现功能", Source: "内置"},
	{Name: "stickers", Type: "builtin", Description: "订购 Claude Code 贴纸", Source: "内置"},
	{Name: "terminal-setup", Type: "builtin", Description: "安装 Shift+Enter 换行绑定", Source: "内置"},
	{Name: "feedback", Type: "builtin", Description: "提交反馈/报告问题/分享会话", Source: "内置"},
	{Name: "release-notes", Type: "builtin", Description: "查看更新日志", Source: "内置"},
	{Name: "exit", Type: "builtin", Description: "退出 Claude Code", Source: "内置"},
}

// bundledSkills 是 Claude Code 自带（bundled）的技能，内嵌于 CLI 二进制，
// 不在 ~/.claude/skills 或插件目录下，磁盘扫描不到；此处硬编码以对齐 / 菜单。
// 去重时放在最后 add：磁盘上若有同名自定义技能则磁盘版优先，本表仅补空白。
var bundledSkills = []CommandSuggestion{
	{Name: "batch", Type: "skill", Description: "规划大规模改动并跨隔离 worktree 并行执行", Source: "内置"},
	{Name: "claude-api", Type: "skill", Description: "Claude API / Anthropic SDK 参考", Source: "内置"},
	{Name: "code-review", Type: "skill", Description: "审查当前 diff 的 bug 与可简化点；强度 low→max 覆盖更广；--fix 直接改、--comment 发 PR 评论", ArgHint: "[low|medium|high|xhigh|max] [--fix] [--comment] [<target>]", Source: "内置"},
	{Name: "deep-research", Type: "skill", Description: "多源深度研究，生成带引用的报告", Source: "内置"},
	{Name: "fewer-permission-prompts", Type: "skill", Description: "扫描历史并加白名单以减少权限提示", Source: "内置"},
	{Name: "run", Type: "skill", Description: "启动并驱动本项目 app 以验证改动", Source: "内置"},
	{Name: "run-skill-generator", Type: "skill", Description: "生成或改进 run-<unit> 项目运行技能", Source: "内置"},
	{Name: "security-review", Type: "skill", Description: "对当前分支待提交改动做安全审查", Source: "内置"},
	{Name: "simplify", Type: "skill", Description: "审查改动代码并应用简化与清理", Source: "内置"},
	{Name: "team-onboarding", Type: "skill", Description: "生成上手指南帮助队友 ramp on", Source: "内置"},
	{Name: "update-config", Type: "skill", Description: "通过 settings.json 配置 harness 行为", Source: "内置"},
	{Name: "verify", Type: "skill", Description: "运行 app 观察行为以验证改动", Source: "内置"},
}

// GetCommandSuggestions 汇总该 cwd 下可用的斜杠命令/技能，用于消息框自动补全。
// 优先级：内置 > 项目(cwd/.claude) > 用户(~/.claude) > 插件(installed_plugins)。
// 每个来源出错（目录/文件缺失）静默跳过，不影响其它来源。按名称去重保留优先级高者。
func GetCommandSuggestions(cwd string) []CommandSuggestion {
	seen := map[string]bool{}
	var out []CommandSuggestion
	add := func(items []CommandSuggestion) {
		for _, it := range items {
			name := strings.ToLower(strings.TrimSpace(it.Name))
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			it.Name = name
			// 描述过长截断（按字符数计数，中英文一致；前端 nowrap+ellipsis 会自适应宽度）
			if d := strings.TrimSpace(it.Description); d != "" {
				if i := strings.IndexAny(d, "\r\n"); i >= 0 {
					d = d[:i]
				}
				if r := []rune(d); len(r) > 80 {
					d = string(r[:80]) + "…"
				}
				it.Description = d
			}
			out = append(out, it)
		}
	}

	add(builtinCommands)

	home, _ := os.UserHomeDir()
	userClaude := ""
	if home != "" {
		userClaude = filepath.Join(home, ".claude")
	}

	// 项目层（当前实例 cwd）
	if cwd != "" {
		add(scanCommands(filepath.Join(cwd, ".claude", "commands"), "项目"))
		add(scanSkills(filepath.Join(cwd, ".claude", "skills"), "项目"))
	}
	// 用户层（~/.claude）
	if userClaude != "" {
		add(scanCommands(filepath.Join(userClaude, "commands"), "用户"))
		add(scanSkills(filepath.Join(userClaude, "skills"), "用户"))
		// 插件层：installed_plugins.json → 各 installPath
		add(scanPlugins(filepath.Join(userClaude, "plugins", "installed_plugins.json")))
	}
	// bundled skills 内嵌于 CLI 二进制，磁盘扫不到，最后补齐（磁盘同名优先）
	add(bundledSkills)
	return out
}

// scanCommands 扫描 dir 下的 *.md 作为自定义斜杠命令：name=文件名去后缀，desc 取 frontmatter。
func scanCommands(dir, source string) []CommandSuggestion {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []CommandSuggestion
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(e.Name(), ".md")
		if name == "" {
			continue
		}
		_, desc, argHint := parseFrontmatter(filepath.Join(dir, e.Name()))
		out = append(out, CommandSuggestion{Name: name, Type: "command", Description: desc, ArgHint: argHint, Source: source})
	}
	return out
}

// scanSkills 扫描 dir 下的 */SKILL.md 作为技能：name 取 frontmatter name（无则用目录名），desc 取 frontmatter。
func scanSkills(dir, source string) []CommandSuggestion {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []CommandSuggestion
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		skillMd := filepath.Join(dir, e.Name(), "SKILL.md")
		name, desc, argHint := parseFrontmatter(skillMd)
		if name == "" {
			name = e.Name() // 无 frontmatter name 时回退到目录名
		}
		out = append(out, CommandSuggestion{Name: name, Type: "skill", Description: desc, ArgHint: argHint, Source: source})
	}
	return out
}

// scanPlugins 解析 installed_plugins.json，对每个 installPath 扫描其 commands/ 与 skills/。
func scanPlugins(jsonPath string) []CommandSuggestion {
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil
	}
	// 结构宽松：只取 installPath 字段，忽略版本/作用域等。
	var doc struct {
		Plugins map[string][]struct {
			InstallPath string `json:"installPath"`
		} `json:"plugins"`
	}
	if json.Unmarshal(data, &doc) != nil {
		return nil
	}
	var out []CommandSuggestion
	for _, installs := range doc.Plugins {
		for _, ins := range installs {
			p := strings.TrimSpace(ins.InstallPath)
			if p == "" {
				continue
			}
			out = append(out, scanCommands(filepath.Join(p, "commands"), "插件")...)
			out = append(out, scanSkills(filepath.Join(p, "skills"), "插件")...)
		}
	}
	return out
}

// parseFrontmatter 读取 markdown 文件 YAML 头部的 name / description / argument-hint
// （极简行解析，不引入 YAML 依赖）。
// 文件首行须为 "---"，读到下一个 "---" 之间按 "key: value" 提取目标字段；读不到返回空串。
func parseFrontmatter(path string) (name, desc, argHint string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", ""
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", "", ""
	}
	for i := 1; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if line == "---" || line == "" {
			if line == "---" {
				break
			}
			continue
		}
		if v := frontmatterValue(line, "name:"); v != "" && name == "" {
			name = v
		}
		if v := frontmatterValue(line, "description:"); v != "" && desc == "" {
			desc = v
		}
		if v := frontmatterValue(line, "argument-hint:"); v != "" && argHint == "" {
			argHint = v
		}
	}
	return name, desc, argHint
}

// frontmatterValue 若 line 以 "key:" 开头，返回去引号、trim 后的值，否则空串。
func frontmatterValue(line, key string) string {
	if !strings.HasPrefix(line, key) {
		return ""
	}
	v := strings.TrimSpace(strings.TrimPrefix(line, key))
	v = strings.Trim(v, "\"'")
	return v
}
