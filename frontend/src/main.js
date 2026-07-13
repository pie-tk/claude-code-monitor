// 直接使用 Wails runtime Call.ByID，绕过自动绑定的循环依赖问题
// ID 取自自动生成的 frontend/bindings/cc-console/service/monitorservice.js
import { Call, Events } from "@wailsio/runtime";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Binding IDs (FNV-1a hash of "cc-console/service.MonitorService.<Method>")
const ID_DETECT = 3511002957;
const ID_GET_THEME = 397350041;
const ID_GET_CLOCK = 3994026554;
const ID_ACT_CLEAR = 545766049;
const ID_ACT_REWIND = 1735111375;
const ID_ACT_PROMPT = 1205864218;
const ID_ACT_SHOW = 970284573;
const ID_ACT_CLOSE_INSTANCE = 20326635; // ActCloseInstance(pid) — 关闭 Claude Code 并尽量关闭对应终端窗口
const ID_GET_SETTINGS = 236910689;
const ID_SAVE_SETTINGS = 2628092832;
const ID_GET_BRIDGE_STATUS = 1164906267;
const ID_ENABLE_BRIDGE = 1918911982;
const ID_GET_BRIDGE_RULES = 4094932612;
const ID_OPEN_URL = 3952279129;
const ID_CHECK_UPDATE = 1254307161;
const ID_DOWNLOAD_UPDATE = 271309265;
const ID_GET_CHAT_HISTORY = 1507566330;
const ID_GET_RECENT_DIRS = 2735810815;
const ID_LAUNCH_INSTANCE = 1221198416;
const ID_PICK_DIRECTORY = 432997876;
const ID_GET_COMMANDS = 266082154; // GetCommandSuggestions(pid)
const ID_SAVE_LIST_PREFS = 3233443589; // SaveListPrefs(sortField, sortDir)
const ID_ACT_ASK_ANSWER = 1941433663; // ActAskAnswer(pid, actionsJSON) — AskUserQuestion 按键序列注入
const ID_GET_ACCOUNT_USAGE = 1426129106; // GetAccountUsage() — 账号用量（GLM 配额 / DeepSeek 余额）
const ID_SAVE_TEXT_FILE = 4045929184; // SaveTextFile(filename, content) — 原生保存 Markdown/文本
const ID_START_TERMINAL = 2611305340; // StartTerminal(kind, workdir) — 启动内置终端，返回 sessionId
const ID_WRITE_TERMINAL = 484789539; // WriteTerminal(id, data) — 写入键盘输入
const ID_RESIZE_TERMINAL = 4194224864; // ResizeTerminal(id, cols, rows) — 调整终端尺寸
const ID_KILL_TERMINAL = 2250045032; // KillTerminal(id) — 终止内置终端
const ID_LIST_TERMINALS = 2548176281; // ListTerminals() — 列出活跃内置终端

// ---- State ----
let currentPids = [];
let promptTargetPid = null;
let footTimer = null;
let sortField = 'startedAt';
let sortDir = 'desc';
let chatPanelPid = null;
let embeddedPids = null; // 可注入的内置终端 pid 集合（refresh 时由 ListTerminals 更新）。null=尚未加载（乐观不锁，避免首屏误判）；仅 macOS 用于区分不可注入的外部终端实例
let usageState = null; // 账号级用量（GLM 配额 / DeepSeek 余额，全局唯一，与实例解耦）
let chatHistoryHash = 0;
let chatRefreshTimer = null;
let lastChatMessages = [];      // 最近一次渲染的消息，供未变 hash 时重新评估交互按钮
let lastReplySignature = '';    // 上次注入的快速回复签名，避免每秒重复 innerHTML 重写
// 处理中/完成指示器（复刻 Claude Code 风格）：处理中随机切换动词（Channeling…），
// 时间从 Claude Code 实际进入任务执行时刻起算；完成后保留最终用时，直到下一轮任务覆盖。
let procState = 'idle';        // idle | processing | completed
let procStartTime = 0;         // 本轮处理开始时刻(ms)
let procVerbIdx = 0;           // 当前 spinner 动词下标
let procHasBeenBusy = false;   // 本轮是否经历过 busy（用于区分「处理完成」与「乐观窗口内尚未 busy」）
let procOptimistic = false;    // 发送后乐观窗口（status 变 busy 前的空窗）
let procCompletionText = '';   // 完成态文案（含最终用时）
let procTaskStartTime = 0;     // 后端上报的真实任务开始时刻(ms)
let procCompletedTurnEnd = 0;  // 当前已展示为「完成」的轮次结束时刻(ms)，用于跨面板重开判定是否需重算
let procIdleSince = 0;        // 首次观测到 status=idle 的时刻(ms)，用于 idle 滞回（见 procUpdate）
// idle 滞回窗口：Claude Code 长任务中途会阶段性触发 Stop hook（一轮无 pending 工具的回复
// 结束即触发）随即继续，表现为 busy→idle→busy 抖动。要求 idle 连续稳定该时长才判定完成，
// 避免瞬时空窗误显示「已完成」并让计时从 0 重跳。取值需大于典型中途空窗（1~2s）、小于
// 用户能容忍的「真完成延迟」。
const IDLE_SETTLE_MS = 3000;
let verbSwitchTimer = null;    // 处理中动词切换定时器
let optimisticTimer = null;    // 乐观窗口兜底定时器

// Claude Code 风格的 spinner 动词（处理中 gerund + 完成时 past）。取自其动词表的常见词。
var SPINNER_VERBS = [
  { ing: 'Channeling',   ed: 'Channelled' },
  { ing: 'Pondering',    ed: 'Pondered' },
  { ing: 'Crunching',    ed: 'Crunched' },
  { ing: 'Working',      ed: 'Worked' },
  { ing: 'Thinking',     ed: 'Thought' },
  { ing: 'Synthesizing', ed: 'Synthesized' },
  { ing: 'Deliberating', ed: 'Deliberated' },
  { ing: 'Ruminating',   ed: 'Ruminated' },
  { ing: 'Musing',       ed: 'Mused' },
  { ing: 'Conjuring',    ed: 'Conjured' },
  { ing: 'Noodling',     ed: 'Noodled' },
  { ing: 'Distilling',   ed: 'Distilled' },
  { ing: 'Cogitating',   ed: 'Cogitated' },
  { ing: 'Brewing',      ed: 'Brewed' },
  { ing: 'Plotting',     ed: 'Plotted' },
  { ing: 'Scheming',     ed: 'Schemed' },
  { ing: 'Dreaming',     ed: 'Dreamed' },
  { ing: 'Processing',   ed: 'Processed' },
  { ing: 'Analyzing',    ed: 'Analyzed' },
  { ing: 'Cooking',      ed: 'Cooked' },
];
// AskUserQuestion 多问追踪:同一 tool_use 内多个问题按序展示。
// 活跃会话 jsonl 滞后(答完一题 jsonl 不更新),没有外部信号告知「现在问到第几题」,
// 只能本地追踪——用户在消息框点选一题后推进到下一题。tool_use ID 变化或交互消失则重置。
let askToolUseId = '';
let askQuestionIndex = 0;
let askQuestionCount = 0;
// AskUserQuestion 已选答案记忆：key = askToolUseId + '#' + askQuestionIndex。
// value 结构：
//   { kind:'single', optionIndex:number, label:string }
//   { kind:'multi', picks:{optionIndex:true}, labels:string[], customSelected?:boolean, customText?:string }
//   { kind:'custom', text:string }
// 这里只记录“真正选择/提交”的答案；Type something 文本本身单独存 askCustomOptions。
let askAnswers = {};
// 多选勾选态：key = askToolUseId + '#' + askQuestionIndex，value = {picks:{optionIndex:true}, customSelected:boolean}。
// 用 tool_use id + 题号隔离；轮询重渲染时不进签名，勾选靠就地翻转 class 保留（见 toggleAskPick/toggleAskCustomPick）。
let askMultiSelectPicks = {};
// Type something 已创建的自定义选项：key = askToolUseId + '#' + askQuestionIndex，value = {text:string}。
// “输入自定义文本”和“选择该自定义项”分成两步：确定只写入 Type something，之后再次点击自定义项才算选择。
let askCustomOptions = {};
// Type something 内联编辑器态：{ key, questionIndex, mode:'create'|'edit', draft }；null 表示未编辑。
let askCustomEditor = null;
// 终端 AskUserQuestion TUI 的焦点位置估计：key → item index（原始选项 0..n-1，自定义项 n，Type something n(+1)）。
// 由于终端状态无法读回，所有由本应用发出的导航都在这里做乐观同步。
let askTerminalFocus = {};
// AskUserQuestion 实时旁路:活跃会话 JSONL 不落盘(2.1.169+),AskUserQuestion 的 questions
// 只能由 PreToolUse hook 实时捕获(后端 ask/<pid>.json,经 GetChatHistory.pendingAsk 透传)。
// detectInteraction 在 JSONL 找不到挂起 tool_use 时回退用它合成 kind:'ask'。null=无挂起。
let currentLiveAsk = null;
const CHAT_CHANGE_WIDTH_KEY = 'cc-console.chatChangePanelWidth';
const CHAT_CHANGE_HIDDEN_KEY = 'cc-console.chatChangePanelHidden';
let chatChangePanelVisible = true; // 右侧文件修改面板显隐状态（按会话记忆，用户隐藏后不再自动弹出）
let chatChangePanelWidth = loadChatChangePanelWidth(); // 右侧文件修改面板宽度（可拖动调整）
let chatChangePanelHiddenBySession = loadChatChangePanelHiddenPrefs(); // key(pid/session|cwd) → true 表示该会话保持隐藏
let highlightedChangeId = ''; // 右侧修改面板当前高亮项
let lastChatRenderModel = { items: [], changes: [] }; // 最近一次聊天渲染模型，供右侧面板/定位复用
let markdownDownloads = {}; // markdown 下载缓存：id → {filename, content}
let instanceMeta = {}; // pid → {topic, model}
let newInstanceSelected = -1; // 新建实例面板当前选中项索引
let newInstanceItems = [];    // 新建实例面板项：[{type:'dir',path}, {type:'pick'}]
let sendOnEnter = true;       // 消息框发送键：true=回车发送(Shift+回车换行)；false=回车换行(Shift+回车发送)
let autoCheckClaudeSettings = true;
let autoRepairClaudeSettings = true;
let launchYoloSetting = true;     // 设置面板里可能没有对应 DOM，保存其它设置时仍需保留后端当前值
let chatDrafts = {};           // 消息框草稿：key = pid|cwd，关闭面板后保留，重新打开时恢复
let chatScrollPositions = {};   // 对话滚动位置：key = pid|cwd，切换会话后恢复阅读位置
let pendingChatScrollRestore = null; // 下一次 renderChatMessages 后应用的一次性滚动恢复
let bridgeStatusWarnKey = '';   // 避免 settings.json 漂移告警每 10s 重复弹
let bridgeRepairInFlight = false;

// ---- 斜杠命令自动补全状态 ----
let slashList = [];       // 全量命令/技能建议缓存
let slashFiltered = [];   // 当前筛选结果
let slashIdx = 0;         // 选中下标
let slashOpen = false;    // 下拉是否展开
let slashHintActive = false; // 参数提示行展示中（此模式放行 Enter/方向键，仅 Esc 关闭）
let slashInput = null;    // 当前绑定的 textarea（chat-input 或 prompt-input）

// ---- 斜杠使用统计（驱动补全排序：上次使用置顶，其余按次数降序，兜底字母序）----
// 持久化于 localStorage，跨会话累积；acceptSlash 补全时更新。
let slashUsage = {};
let lastSlashName = '';
try { slashUsage = JSON.parse(localStorage.getItem('cc-slash-usage') || '{}') || {}; } catch (e) { slashUsage = {}; }
lastSlashName = localStorage.getItem('cc-slash-last') || '';

// ---- 输入历史导航（↑/↓ 切换历史消息）----
// 数据源：当前会话对话历史里的 user 真实消息 ∪ 本输入框发送历史栈，合并去重。
// 发送历史栈补上「活跃会话 JSONL 不落盘」导致 lastChatMessages 滞后的最新发送。
let chatSendHistory = [];      // 发送历史栈：跨会话累积，去重，最新在末尾
let chatHistoryIdx = -1;       // 导航索引：-1=未导航；[0..len]，len=最新之后(空/草稿)
let chatHistoryDraft = '';     // 进入导航前保存的当前草稿
let chatHistoryFilling = false;// 导航填充置位，防 input 误判为手动编辑而脱离

// ---- 目录筛选状态（纯前端，本次启动生效，不持久化）----
// dirFilterHidden 记录被隐藏的 cwd（→ true）；未记录的目录默认显示。
let dirFilterHidden = {};
let dirFilterSig = '';   // 唯一目录签名，变化时才重建下拉 DOM（避免每秒刷新抖动）

// ---- 主区布局状态（list 实例卡片列表 / chat 左会话标签 + 右对话），持久化到 settings.viewMode ----
let viewMode = 'chat';          // 当前布局：list | chat（首次使用默认会话布局）
let liveStalePids = [];         // 排序后的运行中实例 pid 列表（renderCards 每秒更新），供会话标签渲染
let sessionTabsSig = '';        // 会话标签结构签名；结构稳定时仅局部刷新状态，避免每秒重建 DOM
let showSessionSubtitle = true; // chat 布局会话标签是否显示目录副标题
let closingPids = {};            // 正在关闭的实例 pid，防重复点击

// ---- 聊天面板回溯提示 ----
let chatHintTimer = null;

// fetchAccountUsage 拉取账号级用量（按当前后端：GLM 配额 / DeepSeek 余额），存全局 usageState。
// 低频轮询（60s）+ 后端 120s 缓存兜底（且感知 settings.json 变化）；网络错误不清空上次有效值。
async function fetchAccountUsage() {
  try {
    var u = await Call.ByID(ID_GET_ACCOUNT_USAGE);
    // 始终覆盖全局状态：切到不支持/无 token 的 provider 时，后端会返回
    // {available:false, provider:"", reason:"unsupported"|"no-token"}；若只在真值时赋值，
    // 会把上一家（如 GLM）的旧配额残留在右下角。null 也显式收敛为 null，确保 UI 可隐藏。
    usageState = u || null;
  } catch (e) {
    console.warn("GetAccountUsage failed:", e);
  }
}

// ---- Boot ----
async function boot() {
  try {
    await applyTheme();
  } catch (e) {
    console.error("Theme init error:", e);
  }
  loadSendMode(); // 加载消息框发送键设置，更新占位符/提示文案
  await loadListPrefs(); // 加载持久化的列表偏好（排序 + 布局），需在首次 refresh 前应用布局
  initSlashAutocomplete(); // 绑定消息框斜杠命令自动补全
  initDirFilter(); // 绑定目录筛选下拉的外部点击关闭
  window.addEventListener('resize', applyChatChangePanelWidth);
  refresh();
  pollBridgeStatus();
  setInterval(refresh, 1000);
  setInterval(pollBridgeStatus, 10000);
  fetchAccountUsage();
  setInterval(fetchAccountUsage, 15000); // 账号用量轮询：15s 拉取（后端 60s 缓存兜底 + settings.json 切换感知）
  startUpdateChecks(); // 启动检查一次版本更新，之后每 24h 自动检查
}

// 加载发送键设置（回车发送 or Shift+回车发送），并刷新输入框提示文案。
async function loadSendMode() {
  try {
    var s = await Call.ByID(ID_GET_SETTINGS);
    if (s) {
      sendOnEnter = !!s.enterToSend;
      updateSendHints();
    }
  } catch (e) { /* 读取失败保持默认 true */ }
}

// 依据 sendOnEnter 同步两处输入框的提示文案。
function updateSendHints() {
  var chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.placeholder = sendOnEnter
      ? "输入消息，Enter 发送，Shift+Enter 换行..."
      : "输入消息，Shift+Enter 发送，Enter 换行...";
  }
  var sub = document.getElementById("prompt-subtitle");
  if (sub) {
    sub.textContent = sendOnEnter
      ? "输入文字后点击 发送 或按 Enter。多行会被折叠为空格。"
      : "输入文字后点击 发送 或按 Shift+Enter。多行会被折叠为空格。";
  }
}

// 加载持久化的列表排序偏好（字段 + 方向），覆盖内存默认值并同步排序栏高亮。
async function loadListPrefs() {
  try {
    var s = await Call.ByID(ID_GET_SETTINGS);
    if (s) {
      if (s.sortField) sortField = s.sortField;
      if (s.sortDir) sortDir = s.sortDir;
      if (s.viewMode === 'list' || s.viewMode === 'chat') viewMode = s.viewMode;
      if (typeof s.showSessionSubtitle === 'boolean') showSessionSubtitle = s.showSessionSubtitle;
      updateSortBar();
      applyViewMode(); // 应用持久化的布局（容器显隐 + .chat-dialog 挂载点）
    }
  } catch (e) { /* 读取失败保持默认 */ }
}

// 持久化当前排序偏好（字段 + 方向）。失败静默，不阻断 UI。
async function saveListPrefs() {
  try {
    await Call.ByID(ID_SAVE_LIST_PREFS, sortField, sortDir, viewMode, showSessionSubtitle);
  } catch (e) { /* 忽略 */ }
}

// ---- 主区布局切换（list 实例卡片 / chat 左标签 + 右对话） ----

// applyViewMode 按 viewMode 同步主区容器显隐、body 标记 class，并把 .chat-dialog
// 子树移动到对应挂载点（chat→#chat-pane 内联；list→#chat-overlay 作 modal）。
// 移动整棵子树后所有 chat-* 的 getElementById 仍命中，渲染函数无需改动。
function applyViewMode() {
  var cards = document.getElementById('cards-container');
  var split = document.getElementById('split-view');
  if (cards) cards.classList.toggle('hidden', viewMode === 'chat');
  if (split) split.classList.toggle('hidden', viewMode !== 'chat');
  document.body.classList.toggle('chat-layout', viewMode === 'chat');
  updateSortBar();
  updateLayoutToggle();
  // 移动对话子树挂载点（仅切布局时发生一次，不在每秒 refresh / 切 tab 里做）
  var dialog = document.getElementById('chat-dialog');
  if (dialog) {
    var host = viewMode === 'chat'
      ? document.getElementById('chat-pane')
      : document.getElementById('chat-overlay');
    if (host && dialog.parentNode !== host) host.appendChild(dialog);
  }
}

// updateLayoutToggle 根据当前布局刷新右上角切换按钮：仅显示点击后的目标布局图标。
function updateLayoutToggle() {
  var btn = document.getElementById('layout-toggle-btn');
  if (!btn) return;
  var isChat = viewMode === 'chat';
  btn.classList.toggle('mode-chat', isChat);
  btn.classList.toggle('mode-list', !isChat);
  btn.title = isChat ? '切换到实例列表' : '切换到对话布局';
  btn.setAttribute('aria-label', btn.title);
}

function loadChatChangePanelWidth() {
  try {
    var v = parseInt(localStorage.getItem(CHAT_CHANGE_WIDTH_KEY) || '', 10);
    if (v >= 280 && v <= 900) return v;
  } catch (e) { /* ignore */ }
  return 420;
}

function persistChatChangePanelWidth() {
  try { localStorage.setItem(CHAT_CHANGE_WIDTH_KEY, String(chatChangePanelWidth)); } catch (e) { /* ignore */ }
}

function loadChatChangePanelHiddenPrefs() {
  try {
    var raw = localStorage.getItem(CHAT_CHANGE_HIDDEN_KEY) || '{}';
    var obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

function persistChatChangePanelHiddenPrefs() {
  try { localStorage.setItem(CHAT_CHANGE_HIDDEN_KEY, JSON.stringify(chatChangePanelHiddenBySession || {})); } catch (e) { /* ignore */ }
}

function currentChatChangeSessionKey() {
  return chatSessionKey(chatPanelPid);
}

function chatChangePanelMaxWidth() {
  var wrap = document.querySelector('.chat-scroll-wrap');
  if (!wrap || !wrap.clientWidth) return 900;
  // 给左侧对话正文至少保留一段可读宽度，避免修改面板过宽时拖动线贴到会话列表滚动条。
  return Math.max(280, Math.min(900, wrap.clientWidth - 360));
}

function clampChatChangePanelWidth(width) {
  return Math.max(280, Math.min(chatChangePanelMaxWidth(), width));
}

function repositionChatChangeResizer() {
  var resizer = document.getElementById('chat-change-resizer');
  var panel = document.getElementById('chat-change-panel');
  if (!resizer) return;
  if (!panel || panel.classList.contains('hidden')) {
    resizer.classList.add('hidden');
    resizer.classList.remove('collapsed');
    return;
  }
  var collapsed = panel.classList.contains('collapsed');
  resizer.classList.remove('hidden');
  resizer.classList.toggle('collapsed', collapsed);
  resizer.style.right = collapsed ? '0px' : (chatChangePanelWidth + 'px');
}

function applyChatChangePanelWidth() {
  chatChangePanelWidth = clampChatChangePanelWidth(chatChangePanelWidth);
  var panel = document.getElementById('chat-change-panel');
  if (panel) {
    panel.style.width = chatChangePanelWidth + 'px';
    panel.style.flexBasis = chatChangePanelWidth + 'px';
  }
  repositionChatChangeResizer();
}

// setChatChangePanelDomState 区分“无修改项隐藏”和“用户隐藏时折叠”，折叠态保留 DOM 才能做过渡动画。
function setChatChangePanelDomState(hasChanges) {
  var panel = document.getElementById('chat-change-panel');
  var resizer = document.getElementById('chat-change-resizer');
  if (!panel) return;
  if (!hasChanges) {
    panel.classList.add('hidden');
    panel.classList.remove('collapsed');
    if (resizer) {
      resizer.classList.add('hidden');
      resizer.classList.remove('collapsed');
    }
    return;
  }
  panel.classList.remove('hidden');
  panel.classList.toggle('collapsed', !chatChangePanelVisible);
  if (resizer) {
    resizer.classList.remove('hidden');
    resizer.classList.toggle('collapsed', !chatChangePanelVisible);
  }
  if (chatChangePanelVisible) applyChatChangePanelWidth();
  else repositionChatChangeResizer();
}

function syncChatChangePanelVisibilityFromPrefs(pid) {
  var key = chatSessionKey(pid);
  chatChangePanelVisible = !(key && chatChangePanelHiddenBySession[key]);
}

function setChatChangePanelVisibility(visible) {
  chatChangePanelVisible = !!visible;
  var key = currentChatChangeSessionKey();
  if (key) {
    if (visible) delete chatChangePanelHiddenBySession[key];
    else chatChangePanelHiddenBySession[key] = true;
    persistChatChangePanelHiddenPrefs();
  }
}

function startChatChangeResize(ev) {
  ev.preventDefault();
  var startX = ev.clientX;
  var startWidth = chatChangePanelWidth;
  function onMove(e) {
    var next = clampChatChangePanelWidth(startWidth - (e.clientX - startX));
    chatChangePanelWidth = next;
    applyChatChangePanelWidth();
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    persistChatChangePanelWidth();
    repositionChatChangeResizer();
  }
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// switchLayout 在 list/chat 间切换；不带参数则 toggle。切换前清理旧模式状态。
window.switchLayout = function(mode) {
  if (mode !== 'list' && mode !== 'chat') mode = (viewMode === 'list' ? 'chat' : 'list');
  if (mode === viewMode) return;
  if (chatPanelPid !== null) closeChatPanel(); // 切布局前先关当前对话（modal 收 overlay / 内联显空态）
  viewMode = mode;
  applyViewMode();
  saveListPrefs();
  if (viewMode === 'chat') {
    renderSessionTabs();
    var first = firstLivePid();
    if (first !== null) selectSession(first);
    else showChatPaneEmpty();
  }
};

// firstLivePid 返回当前首个运行中实例 pid，无则 null。
function firstLivePid() {
  return liveStalePids.length ? liveStalePids[0] : null;
}

// showChatPaneEmpty 显示右栏空态（无运行中实例 / 未选中）。dialog 永不 hidden，靠空态覆盖层遮挡。
function showChatPaneEmpty() {
  var empty = document.getElementById('chat-pane-empty');
  if (empty) empty.classList.remove('hidden');
}

// selectSession 选中某个实例标签并在右栏打开其对话（chat 模式专用）。
window.selectSession = function(pid) {
  if (pid === chatPanelPid) return;           // 已选中
  if (chatPanelPid !== null) closeChatPanel({ keepPane: true }); // 切换前保存旧会话状态,但不闪空态
  var tabs = document.getElementById('session-tabs-list');
  if (tabs) {
    var items = tabs.querySelectorAll('.session-tab');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', Number(items[i].getAttribute('data-pid')) === pid);
    }
  }
  openChatPanel(pid);
};

// toggleSessionSubtitle 切换会话标签目录副标题显示（常规设置开关）。
window.toggleSessionSubtitle = function(val) {
  showSessionSubtitle = !!val;
  saveListPrefs();
  renderSessionTabs();
};

function sessionStatusClass(status) {
  return status === 'busy' || status === 'idle' ? status : 'unknown';
}

function sessionWaitingInfo(waitingKind) {
  if (waitingKind === 'ask') return { title: '等待选择', badge: '待选' };
  if (waitingKind === 'plan') return { title: '等待计划审批', badge: '审批' };
  if (waitingKind === 'permission') return { title: '等待权限确认', badge: '授权' };
  return { title: '', badge: '' };
}

// updateSessionTabState 每秒轻量刷新状态类，避免结构签名不变时 busy/idle 圆点滞后。
function updateSessionTabState(el, pid) {
  var m = instanceMeta[pid] || {};
  var topic = m.topic || '<新会话>';
  var status = sessionStatusClass(m.status || 'unknown');
  var waitingKind = m.waitingKind || '';
  var info = sessionWaitingInfo(waitingKind);

  el.classList.toggle('active', pid === chatPanelPid);
  el.classList.toggle('waiting', !!waitingKind);
  el.classList.toggle('closing', !!closingPids[pid]);
  var staleWaiting = [];
  for (var i = 0; i < el.classList.length; i++) {
    var cls = el.classList.item(i);
    if (cls && cls.indexOf('waiting-') === 0) staleWaiting.push(cls);
  }
  for (var j = 0; j < staleWaiting.length; j++) el.classList.remove(staleWaiting[j]);
  if (waitingKind) el.classList.add('waiting-' + waitingKind);
  el.title = info.title ? (info.title + ' · ' + topic) : topic;

  var dot = el.querySelector('.session-tab-dot');
  if (dot) {
    dot.classList.toggle('busy', status === 'busy');
    dot.classList.toggle('idle', status === 'idle');
    dot.classList.toggle('unknown', status === 'unknown');
  }
  var badge = el.querySelector('.session-tab-wait-badge');
  if (badge) badge.textContent = info.badge;
}

function updateSessionTabsState(listEl) {
  var items = listEl.querySelectorAll('.session-tab');
  for (var i = 0; i < items.length; i++) {
    var pid = Number(items[i].getAttribute('data-pid'));
    if (!isNaN(pid)) updateSessionTabState(items[i], pid);
  }
}

// renderSessionTabs 渲染左侧会话标签列表。结构签名（pid+topic+副标题等）变化才重建 DOM，
// 状态类（busy/idle/active/closing）每秒就地刷新，避免状态点滞后。
function renderSessionTabs() {
  var listEl = document.getElementById('session-tabs-list');
  var emptyEl = document.getElementById('session-tabs-empty');
  if (!listEl) return;
  if (!liveStalePids.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    sessionTabsSig = '';
    return;
  }
  if (emptyEl) emptyEl.classList.add('hidden');
  var topics = liveStalePids.map(function(p) {
    var m = instanceMeta[p]; return (m && m.topic) ? m.topic : '';
  });
  var waiting = liveStalePids.map(function(p) {
    var m = instanceMeta[p]; return (m && m.waitingKind) ? m.waitingKind : '';
  });
  var closing = liveStalePids.map(function(p) { return closingPids[p] ? '1' : ''; });
  // 签名含副标题（目录）与显示开关：开关切换或目录变化才重建。active/status 走局部刷新。
  var subs = showSessionSubtitle ? liveStalePids.map(function(p) {
    var m = instanceMeta[p]; return (m && m.cwd) ? m.cwd : '';
  }).join('⊥') : '';
  var sig = liveStalePids.join(',') + '|' + topics.join('⊕') + '|' + waiting.join('⊙') + '|' + closing.join('⊗') + '|' + subs;
  if (sig === sessionTabsSig && listEl.children.length === liveStalePids.length) {
    updateSessionTabsState(listEl);
    return;
  }
  sessionTabsSig = sig;
  var html = '';
  for (var i = 0; i < liveStalePids.length; i++) {
    var pid = liveStalePids[i];
    var m = instanceMeta[pid] || {};
    var topic = m.topic || '<新会话>';
    var status = sessionStatusClass(m.status || 'unknown');
    var waitingKind = m.waitingKind || '';
    var active = pid === chatPanelPid ? ' active' : '';
    var waitingCls = waitingKind ? (' waiting waiting-' + waitingKind) : '';
    var closingCls = closingPids[pid] ? ' closing' : '';
    var info = sessionWaitingInfo(waitingKind);
    var sub = (showSessionSubtitle && m.cwd) ? '<span class="session-tab-sub">' + escHtml(cwdTitle(m.cwd)) + '</span>' : '';
    html += '<div class="session-tab' + active + waitingCls + closingCls + '" data-pid="' + pid + '" onclick="selectSession(' + pid + ')" title="' + escAttr(info.title ? (info.title + ' · ' + topic) : topic) + '">'
      + '<span class="session-tab-dot ' + status + '"></span>'
      + '<span class="session-tab-info">'
      + '<span class="session-tab-name">' + escHtml(topic) + '</span>'
      + sub
      + '</span>'
      + (info.badge ? '<span class="session-tab-wait-badge">' + info.badge + '</span>' : '')
      + '<button class="session-tab-close" onclick="handleCloseSession(event, ' + pid + ')" title="关闭该 Claude Code">×</button>'
      + '</div>';
  }
  listEl.innerHTML = html;
}

boot();

// ---- Theme ----
async function applyTheme() {
  const info = await Call.ByID(ID_GET_THEME);
  if (!info) return;
  document.body.classList.toggle("dark", info.isDark);
  if (info.css) {
    const root = document.documentElement;
    for (const [key, val] of Object.entries(info.css)) {
      root.style.setProperty(key, val);
    }
  }
  applyTerminalTheme(info.isDark);
}

// ---- Refresh Loop ----
async function refresh() {
  try {
    const result = await Call.ByID(ID_DETECT);
    const live = (result && result.live) || [];
    const stale = (result && result.stale) || [];
    const stats = (result && result.stats) || {};

    // 同步内置终端 pid 集合：区分可注入的内置实例与外部终端实例（macOS 后者无法注入）
    try {
      const terms = await Call.ByID(ID_LIST_TERMINALS);
      embeddedPids = new Set((terms || []).map(function(t) { return t.pid; }));
    } catch (_) { /* ListTerminals 不可用时保持旧集合 */ }

    updateStats(stats);
    updateClock();
    renderCards(live, stale);
    updateFooter(live, stats);
    renderUsageBadge(); // 首页顶部账号用量徽标（每秒刷新，倒计时走）

    // 面板指向的实例已退出（从列表消失）→ 自动关闭，避免残留死面板无法交互。
    // instanceMeta 由 renderCards 用 live+stale 重建，实例消失后即变 undefined。
    if (chatPanelPid !== null && !instanceMeta[chatPanelPid]) {
      var gonePid = chatPanelPid;
      closeChatPanel();
      flashFoot("📭  实例 PID " + gonePid + " 已退出，对话面板已自动关闭");
      // chat 布局下接力到下一个实例，否则显空态
      if (viewMode === 'chat') {
        var next = firstLivePid();
        if (next !== null) selectSession(next); else showChatPaneEmpty();
      }
    }

    // 聊天面板打开时同步刷新消息 + 底部 context/tokens 信息条
    if (chatPanelPid !== null) {
      refreshChatMessages(chatPanelPid);
      renderChatStats(chatPanelPid);
      updateChatInputLockState(); // 内置/外部状态可能变化（首次 ListTerminals 到达后需刷新锁态）
    }
    // chat 布局下刷新左侧会话标签（实例增减 / 主题变化 / 选中变化）；
    // 若未选中任何会话但有运行中实例，自动选中首个（覆盖首次进入 chat 模式 / 新实例出现）
    if (viewMode === 'chat') {
      renderSessionTabs();
      if (chatPanelPid === null) {
        var first = firstLivePid();
        if (first !== null) selectSession(first);
      }
    }
  } catch (e) {
    console.error("Refresh error:", e);
    const msg = e && e.message ? e.message : String(e);
    document.getElementById("foot-msg").textContent = "检测出错: " + msg;
    document.getElementById("foot-msg").className = "foot-msg fresh";
  }
}

async function pollBridgeStatus() {
  try {
    if (!autoCheckClaudeSettings) return;
    const info = await Call.ByID(ID_GET_BRIDGE_STATUS);
    if (!info) return;
    var drift = [];
    if (!info.hooked) drift.push('statusLine');
    if (info.enabled && !info.hooksInstalled) drift.push('lifecycle hooks');
    var key = drift.join('|');
    if (!key) {
      bridgeStatusWarnKey = '';
      return;
    }
    if (!info.enabled) return;
    if (!autoRepairClaudeSettings) {
      if (bridgeStatusWarnKey !== key) {
        flashFoot('⚠ 检测到 ~/.claude/settings.json 已偏离监控器要求：缺少 ' + drift.join(' + ') + '；当前仅检测，不自动修复');
      }
      bridgeStatusWarnKey = key;
      return;
    }
    if (bridgeRepairInFlight) return;
    bridgeRepairInFlight = true;
    try {
      await Call.ByID(ID_ENABLE_BRIDGE);
      if (bridgeStatusWarnKey !== key) {
        flashFoot('🔧 已自动修复 ~/.claude/settings.json：恢复 ' + drift.join(' + '));
      }
      bridgeStatusWarnKey = key;
    } catch (e) {
      if (bridgeStatusWarnKey !== key) {
        flashFoot('⚠ 自动修复 ~/.claude/settings.json 失败：' + (e && e.message ? e.message : e));
      }
      bridgeStatusWarnKey = key;
    } finally {
      bridgeRepairInFlight = false;
    }
  } catch (e) {
    // 静默：轮询告警不应打断主刷新
  }
}

// ---- Stats ----
function updateStats(stats) {
  const el = document.getElementById("stats");
  if (!stats || stats.online === 0) {
    el.textContent = "🌙  当前无实例运行";
    return;
  }
  const parts = ["在线 " + stats.online, "🔴 " + stats.busy + " 忙碌", "🟢 " + stats.idle + " 空闲"];
  if (stats.totalTokens > 0) parts.push("📦 " + formatTokens(stats.totalTokens) + " tokens");
  if (stats.stale > 0) parts.push("🌓 " + stats.stale + " 残留");
  el.textContent = parts.join("  ·  ");
}

// renderUsageBadge 渲染首页顶部账号用量徽标（账号级，随 refresh 每秒刷新，倒计时走）。
// GLM → 「📊 5h 配额 [进度条] N% · Xh」(hover 月度明细)；DeepSeek → 「💰 余额 ¥X」(hover 赠送/充值)；其余隐藏。
function renderUsageBadge() {
  var el = document.getElementById("usage-badge");
  if (!el) return;
  var u = usageState;
  if (!u || !u.available || (u.provider !== "glm" && u.provider !== "deepseek")) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  if (u.provider === "glm") {
    el.className = "usage-badge";
    var t = u.tokens || {};
    var html = quotaGroupHTML('📊 5h', t.percentage || 0, t.nextResetTime || 0);
    if (u.weekly) {
      var w = u.weekly;
      html += '<span class="usage-sep"></span>'
        + quotaGroupHTML('📅 周', w.percentage || 0, w.nextResetTime || 0);
    }
    el.innerHTML = html;
  } else {
    el.className = "usage-badge";
    el.title = balanceTooltip(u.balance);
    el.innerHTML =
      '<span class="usage-label">💰 余额</span>' +
      '<span class="usage-value">' + balanceDisplay(u.balance) + '</span>';
  }
}

// quotaGroupHTML 渲染单个限额组（标签 + 进度条 + 百分比 + 重置倒计时），5h 与周限额复用。
function quotaGroupHTML(label, pct, nextResetMs) {
  var cls = quotaBarClass(pct);
  var reset = quotaCountdownShort(nextResetMs || 0);
  return '<span class="usage-label">' + label + '</span>' +
    '<span class="usage-bar ctx-progress' + (cls ? " " + cls : "") + '">' +
      '<span class="ctx-progress-track"><span class="ctx-progress-fill" style="width:' + Math.min(100, Math.max(0, pct)) + '%"></span></span>' +
    '</span>' +
    '<span class="usage-value' + (cls ? " " + cls : "") + '">' + pct + '%</span>' +
    (reset ? '<span class="usage-reset">· ' + reset + '</span>' : '');
}

// quotaCountdownShort 简短倒计时（首页徽标用）：>1 天 → Xd Yh；<1 天 → Xh Ym。
function quotaCountdownShort(nextResetMs) {
  if (!nextResetMs) return "";
  var ms = nextResetMs - Date.now();
  if (ms <= 0) return "即将重置";
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  if (h >= 24) {
    var d = Math.floor(h / 24);
    var rh = h % 24;
    return d + "d" + (rh > 0 ? rh + "h" : "");
  }
  if (h > 0) return h + "h" + (m > 0 ? m + "m" : "");
  if (m > 0) return m + "m";
  return s + "s";
}

function updateClock() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  document.getElementById("clock").textContent = "⏱  " + h + ":" + m + ":" + s;
}

// ---- Cards ----
function renderCards(live, stale) {
  const container = document.getElementById("cards");
  const emptyState = document.getElementById("empty-state");
  const all = sortInstances([...live, ...stale.map(s => Object.assign({}, s, { _stale: true }))]);

  // 构建实例元数据：topic/model/status 供聊天面板标题与交互判定，
  // 另带 context/tokens 字段供聊天面板底部信息条显示（与卡片同形式）。
  // 用未筛选的 all 构建，确保被筛选隐藏的实例在面板已打开时仍可刷新。
  const newMeta = {};
  for (var i = 0; i < all.length; i++) {
    var inst = all[i];
    newMeta[inst.pid] = {
      topic: inst.topic || '',
      model: inst.model || '',
      branch: inst.gitBranch || '',
      cwd: inst.cwd || '',
      sessionId: inst.sessionId || '',
      status: inst.status || 'unknown',
      waitingKind: inst.waitingKind || '',
      hasConversation: !!inst.hasConversation,
      contextTokens: inst.contextTokens || 0,
      contextLimit: inst.contextLimit || 0,
      outputTokens: inst.outputTokens || 0,
      bridgeConnected: !!inst.bridgeConnected,
      costUsd: inst.costUsd || 0,
      durationMs: inst.durationMs || 0,
      taskStartedAt: inst.taskStartedAt || 0,
      totalInputTokens: inst.totalInputTokens || 0,
      totalOutputTokens: inst.totalOutputTokens || 0,
      totalCacheTokens: inst.totalCacheTokens || 0,
      waitingKind: inst.waitingKind || '',
    };
  }
  instanceMeta = newMeta;
  liveStalePids = all.map(function(i) { return i.pid; });

  // 刷新目录筛选下拉（含按钮显隐、文案、勾选态）
  renderDirFilter(all);

  if (all.length === 0) {
    container.innerHTML = "";
    emptyState.classList.remove("hidden");
    currentPids = [];
    return;
  }

  // 应用目录筛选：dirFilterHidden 中记录的 cwd 被隐藏
  const shown = applyDirFilter(all);

  // 全部被筛选隐藏 → 显示专门空态
  if (shown.length === 0) {
    container.innerHTML = '<div class="filter-empty">'
      + '<div class="empty-icon">🔍</div>'
      + '<div class="empty-title">所有目录都已被筛选隐藏</div>'
      + '<div class="empty-hint">点击右上角「📂 目录筛选」恢复勾选</div>'
      + '</div>';
    emptyState.classList.add("hidden");
    currentPids = [];
    return;
  }
  emptyState.classList.add("hidden");

  const newPids = shown.map(i => i.pid).join(",");
  const oldPids = currentPids.join(",");

  if (newPids !== oldPids) {
    container.innerHTML = shown.map(cardHTML).join("");
    currentPids = shown.map(i => i.pid);
    container.querySelectorAll(".card-history").forEach(function(h) { h.scrollTop = h.scrollHeight; });
  } else {
    shown.forEach((inst, i) => {
      updateCardText(container.children[i], inst);
    });
  }
}

// ---- Sort ----
function sortInstances(arr) {
  if (sortField === 'updatedAt') {
    // 最后活动：先按 busy > idle > stale 分组，再按时间排序
    // 降序（最新在前）：busy 优先 → idle → stale，各组内按时间降序
    // 升序（最旧在前）：idle 优先 → busy → stale，各组内按时间升序
    function rank(inst) {
      if (inst._stale) return 2;
      return inst.status === 'busy' ? 0 : 1;
    }
    return arr.slice().sort(function(a, b) {
      var ra = rank(a), rb = rank(b);
      if (ra !== rb) return sortDir === 'desc' ? ra - rb : rb - ra;
      var va = a.updatedAt || 0, vb = b.updatedAt || 0;
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  }
  return arr.slice().sort(function(a, b) {
    var va = a[sortField] || 0;
    var vb = b[sortField] || 0;
    return sortDir === 'desc' ? vb - va : va - vb;
  });
}

window.handleSort = function(field) {
  if (sortField === field) {
    sortDir = sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    sortField = field;
    sortDir = 'desc';
  }
  updateSortBar();
  saveListPrefs(); // 持久化排序偏好，下次启动沿用
  currentPids = [];
  refresh();
};

function updateSortBar() {
  var btns = document.querySelectorAll('.sort-btn');
  for (var i = 0; i < btns.length; i++) {
    var btn = btns[i];
    var isActive = btn.dataset.sort === sortField;
    btn.classList.toggle('active', isActive);
    var arrow = btn.querySelector('.sort-arrow');
    arrow.textContent = isActive ? (sortDir === 'desc' ? '↓' : '↑') : '↓';
    btn.dataset.dir = isActive ? sortDir : 'desc';
  }
}

// ---- 目录筛选下拉 ----

// collectUniqueDirs 返回去重后的 cwd 列表（按首次出现顺序）。
function collectUniqueDirs(all) {
  var seen = {};
  var dirs = [];
  for (var i = 0; i < all.length; i++) {
    var cwd = all[i].cwd || '';
    if (!cwd || seen[cwd]) continue;
    seen[cwd] = true;
    dirs.push(cwd);
  }
  return dirs;
}

// renderDirFilter 刷新筛选按钮显隐/文案与下拉列表。
// 列表 DOM 仅在唯一目录集合变化（签名不同）时重建，避免每秒刷新抖动并保留勾选交互。
function renderDirFilter(all) {
  var dirs = collectUniqueDirs(all);
  var btn = document.getElementById('dir-filter-btn');
  var wrap = document.getElementById('dir-filter-wrap');
  if (!btn || !wrap) return;
  // 仅 ≤1 个唯一目录时隐藏筛选（无意义）
  wrap.style.display = dirs.length > 1 ? '' : 'none';
  if (dirs.length <= 1) return;

  // 按钮文案：有隐藏项时显示「· 隐 N」
  var hiddenInList = 0;
  for (var i = 0; i < dirs.length; i++) {
    if (dirFilterHidden[dirs[i]]) hiddenInList++;
  }
  btn.textContent = hiddenInList > 0 ? '📂 目录筛选 · 隐 ' + hiddenInList : '📂 目录筛选';

  // 签名比对决定是否重建列表 DOM
  var sig = dirs.join('\n');
  if (sig === dirFilterSig) {
    // 集合未变，仍需同步「全选」勾选态（隐藏项可能因实例消失而变化）
    syncSelectAll(dirs);
    return;
  }
  dirFilterSig = sig;

  // 重建复选框列表
  var listEl = document.getElementById('dir-filter-list');
  if (!listEl) return;
  var html = '';
  for (var j = 0; j < dirs.length; j++) {
    var cwd = dirs[j];
    var checked = !dirFilterHidden[cwd];
    // value 用下标索引，cwd 经 data-cwd 传递；目录中含特殊字符故用属性而非内联参数
    html += '<label class="dir-filter-item" title="' + escAttr(cwd) + '">'
      + '<input type="checkbox" data-cwd="' + escAttr(cwd) + '"' + (checked ? ' checked' : '')
      + ' onchange="onDirFilterItemChange(this)">'
      + '<span class="dir-filter-item-label">' + escHtml(cwdTitle(cwd)) + '</span>'
      + '</label>';
  }
  listEl.innerHTML = html;
  syncSelectAll(dirs);
}

// syncSelectAll 按当前目录集合同步「全选」复选框的勾选态。
function syncSelectAll(dirs) {
  var allCb = document.getElementById('dir-filter-selectall');
  if (!allCb) return;
  var allShown = true;
  for (var i = 0; i < dirs.length; i++) {
    if (dirFilterHidden[dirs[i]]) { allShown = false; break; }
  }
  allCb.checked = allShown;
}

// applyDirFilter 过滤掉被隐藏目录的实例。
function applyDirFilter(all) {
  var hasHidden = false;
  for (var k in dirFilterHidden) { if (dirFilterHidden[k]) { hasHidden = true; break; } }
  if (!hasHidden) return all;
  return all.filter(function(i) { return !dirFilterHidden[i.cwd || '']; });
}

window.toggleDirFilter = function(e) {
  if (e) e.stopPropagation();
  var dd = document.getElementById('dir-filter-dropdown');
  if (dd) dd.classList.toggle('hidden');
};

// initDirFilter 绑定「点击下拉外部关闭」。列表内部点击不冒泡，避免误关。
function initDirFilter() {
  document.addEventListener('click', function(e) {
    var dd = document.getElementById('dir-filter-dropdown');
    if (!dd || dd.classList.contains('hidden')) return;
    var wrap = document.getElementById('dir-filter-wrap');
    if (wrap && !wrap.contains(e.target)) {
      dd.classList.add('hidden');
    }
  });
}

// onDirFilterItemChange 单个目录勾选/取消勾选 → 更新隐藏集合并刷新卡片。
window.onDirFilterItemChange = function(cb) {
  var cwd = cb.getAttribute('data-cwd') || '';
  if (cb.checked) delete dirFilterHidden[cwd];
  else dirFilterHidden[cwd] = true;
  // 仅刷新按钮文案与「全选」态，无需重建列表（避免勾选闪烁）
  syncSelectAllFromDOM();
  refreshFilterBtnText();
  currentPids = [];
  refresh();
};

// onDirFilterAllChange 全选/全不选：对当前下拉中所有目录统一显隐。
window.onDirFilterAllChange = function() {
  var allCb = document.getElementById('dir-filter-selectall');
  if (!allCb) return;
  var cbs = document.querySelectorAll('#dir-filter-list input[type=checkbox]');
  for (var i = 0; i < cbs.length; i++) {
    cbs[i].checked = allCb.checked;
    var cwd = cbs[i].getAttribute('data-cwd') || '';
    if (allCb.checked) delete dirFilterHidden[cwd];
    else dirFilterHidden[cwd] = true;
  }
  refreshFilterBtnText();
  currentPids = [];
  refresh();
};

// syncSelectAllFromDOM 从当前 DOM 复选框反推「全选」态。
function syncSelectAllFromDOM() {
  var cbs = document.querySelectorAll('#dir-filter-list input[type=checkbox]');
  var allShown = true;
  for (var i = 0; i < cbs.length; i++) {
    if (!cbs[i].checked) { allShown = false; break; }
  }
  var allCb = document.getElementById('dir-filter-selectall');
  if (allCb) allCb.checked = allShown;
}

// refreshFilterBtnText 按当前 DOM 复选框统计隐藏数并更新按钮文案。
function refreshFilterBtnText() {
  var btn = document.getElementById('dir-filter-btn');
  if (!btn) return;
  var cbs = document.querySelectorAll('#dir-filter-list input[type=checkbox]');
  var hidden = 0;
  for (var i = 0; i < cbs.length; i++) if (!cbs[i].checked) hidden++;
  btn.textContent = hidden > 0 ? '📂 目录筛选 · 隐 ' + hidden : '📂 目录筛选';
}

function cwdTitle(cwd) {
  if (!cwd) return "（未知目录）";
  var parts = cwd.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  if (parts.length <= 2) return cwd;
  return '\\' + parts.slice(-2).join('\\');
}

// ctxProgressHTML 返回 context 胶囊进度条的初始 HTML（卡片首帧直接渲染胶囊，避免字符条→胶囊闪烁）。
// 无 context 数据时回退为文本（"（新会话）" / "—" / 纯数值）。
function ctxProgressHTML(inst) {
  var cls = contextBarClass(inst);
  var hasCtx = inst.hasConversation && inst.contextTokens > 0 && inst.contextLimit > 0;
  if (!hasCtx) {
    return '<span class="context-bar" data-field="ctxBar">' + escHtml(contextBar(inst)) + '</span>';
  }
  var pctVal = Math.min(100, Math.round(inst.contextTokens * 100 / inst.contextLimit));
  return '<span class="ctx-progress' + (cls ? " " + cls : "") + '" data-field="ctxBar">'
    + '<span class="ctx-progress-track"><span class="ctx-progress-fill" style="width:' + pctVal + '%"></span></span>'
    + '</span>';
}

// renderCtxProgress 就地更新胶囊进度条：仅改填充宽度（保留 transition 平滑动画）+ 配色按用量分档；
// 无数据时回退文本。卡片与聊天面板共用。
function renderCtxProgress(el, inst) {
  if (!el) return;
  var cls = contextBarClass(inst);
  var hasCtx = inst.hasConversation && inst.contextTokens > 0 && inst.contextLimit > 0;
  if (!hasCtx) {
    el.className = "context-bar";
    el.textContent = contextBar(inst);
    return;
  }
  var pctVal = Math.min(100, Math.round(inst.contextTokens * 100 / inst.contextLimit));
  var fill = el.querySelector(".ctx-progress-fill");
  if (!fill) {
    el.innerHTML = '<span class="ctx-progress-track"><span class="ctx-progress-fill"></span></span>';
    fill = el.querySelector(".ctx-progress-fill");
  }
  el.className = "ctx-progress" + (cls ? " " + cls : "");
  if (fill) fill.style.width = pctVal + "%";
}

function cardHTML(inst) {
  const stale = inst._stale ? " stale" : "";
  const emoji = statusEmoji(inst.status);
  const statusClass = inst.status || "unknown";
  const label = statusLabel(inst.status);
  const model = modelDisplay(inst);
  const cwd = inst.cwd || "";
  const title = cwdTitle(cwd);
  const topic = topicDisplay(inst);
  const ctxDetail = contextDetail(inst);
  const output = outputDisplay(inst);
  const totalTokens = totalTokensDisplay(inst);

  return '<div class="card' + stale + '" data-pid="' + inst.pid + '">'
    + '<div class="card-inner">'
    + '<div class="card-row">'
    + '<span class="card-emoji">' + emoji + '</span>'
    + '<span class="card-title" data-field="title" title="' + escAttr(topic) + '">' + escHtml(topic) + '</span>'
    + '<span class="card-branch" data-field="branch">' + escHtml(branchDisplay(inst)) + '</span>'
    + '<span class="card-status ' + statusClass + '" data-field="status">' + label + '</span>'
    + '<span class="card-bridge-tag' + (inst.bridgeConnected ? '' : ' show') + '" data-field="bridge" title="statusline 桥接尚未生效，实时数据待接入（新会话刷新后自动接入）">⏳ 未接入</span>'
    + '<span class="card-pid-subtle">PID ' + inst.pid + '</span>'
    + '<span class="card-model" data-field="model">' + model + '</span>'
    + '<span class="card-duration" data-field="duration">' + humanDuration(inst.startedAt) + '</span>'
    + '</div>'
    + '<div class="card-row card-topic-row">'
    + '<span class="card-topic" data-field="topic" title="' + escAttr(cwd) + '">📁 ' + escHtml(title) + '</span>'
    + '</div>'
    + historyHTML(inst)
    + '<div class="card-row card-context">'
    + '<span class="card-context-label">Context</span>'
    + ctxProgressHTML(inst)
    + '<span class="context-pct ' + contextBarClass(inst) + '" data-field="ctxPct">' + contextPct(inst) + '</span>'
    + '<span class="context-detail ' + contextBarClass(inst) + '" data-field="ctxDetail">' + ctxDetail + '</span>'
    + '<span class="card-output" data-field="output">↑ ' + output + '</span>'
    + '</div>'
    + (totalTokens ? '<div class="card-row card-tokens"><span class="card-total-tokens" data-field="totalTokens">📦 ' + totalTokens + '</span></div>' : '')
    + '</div>'
    + '<div class="card-actions">'
    + '<button class="action-btn" onclick="handleClear(' + inst.pid + ')">清空</button>'
    + '<button class="action-btn" onclick="openChatPanel(' + inst.pid + ')">对话</button>'
    + '<button class="action-btn" onclick="handleShowWin(' + inst.pid + ')">窗口</button>'
    + '</div>'
    + '</div>';
}

function updateCardText(el, inst) {
  if (!el) return;
  const set = (sel, val) => { const e = el.querySelector(sel); if (e) e.textContent = val; };
  set("[data-field=title]", topicDisplay(inst));
  set("[data-field=branch]", branchDisplay(inst));
  set("[data-field=status]", statusLabel(inst.status));
  set("[data-field=model]", modelDisplay(inst));
  set("[data-field=duration]", humanDuration(inst.startedAt));
  set("[data-field=topic]", "📁 " + cwdTitle(inst.cwd || ""));
  renderCtxProgress(el.querySelector("[data-field=ctxBar]"), inst);
  var ctxCls = contextBarClass(inst);
  var pctEl = el.querySelector("[data-field=ctxPct]");
  if (pctEl) { pctEl.textContent = contextPct(inst); pctEl.className = "context-pct " + ctxCls; }
  var detailEl = el.querySelector("[data-field=ctxDetail]");
  if (detailEl) { detailEl.textContent = contextDetail(inst); detailEl.className = "context-detail " + ctxCls; }
  set("[data-field=output]", "↑ " + outputDisplay(inst));
  // 对话历史区域：比较 historyHash 而非 turns——assistant 回复追加到已有轮次时
  // turns 不变，但 historyHash（= Σ(len(Q)*31 + len(R)*17)）一定会变。
  var histEl = el.querySelector(".card-history");
  var newHash = inst.historyHash || 0;
  var oldHash = histEl ? parseInt(histEl.getAttribute("data-hist-hash") || "0") : -1;
  if (newHash !== oldHash) {
    if (histEl) {
      histEl.parentNode.removeChild(histEl);
    }
    var histHTML = historyHTML(inst);
    if (histHTML) {
      var tempDiv = document.createElement("div");
      tempDiv.innerHTML = histHTML;
      var newHistEl = tempDiv.firstChild;
      var topicRow = el.querySelector(".card-topic-row");
      if (topicRow && topicRow.nextSibling) {
        topicRow.parentNode.insertBefore(newHistEl, topicRow.nextSibling);
      }
      newHistEl.scrollTop = newHistEl.scrollHeight;
    }
  }

  // 累计 token 行：动态插入/更新/移除
  var totalTokens = totalTokensDisplay(inst);
  var tokensEl = el.querySelector("[data-field=totalTokens]");
  if (totalTokens) {
    if (!tokensEl) {
      // 插入新行到 card-context 之后
      var row = document.createElement("div");
      row.className = "card-row card-tokens";
      row.innerHTML = '<span class="card-total-tokens" data-field="totalTokens">📦 ' + totalTokens + '</span>';
      var ctxRow = el.querySelector(".card-context");
      if (ctxRow && ctxRow.nextSibling) {
        ctxRow.parentNode.insertBefore(row, ctxRow.nextSibling);
      } else if (ctxRow) {
        ctxRow.parentNode.appendChild(row);
      }
    } else {
      tokensEl.textContent = "📦 " + totalTokens;
    }
  } else if (tokensEl) {
    var row = tokensEl.parentNode;
    row.parentNode.removeChild(row);
  }

  var titleEl = el.querySelector("[data-field=title]");
  if (titleEl) titleEl.title = inst.topic || "";
  var topicEl = el.querySelector("[data-field=topic]");
  if (topicEl) topicEl.title = inst.cwd || "";
  var statusEl = el.querySelector(".card-status");
  if (statusEl) statusEl.className = "card-status " + (inst.status || "unknown");
  set(".card-emoji", statusEmoji(inst.status));
  var bridgeEl = el.querySelector("[data-field=bridge]");
  if (bridgeEl) bridgeEl.classList.toggle("show", !inst.bridgeConnected);
}

// ---- Escape helpers ----
function escHtml(s) { s = String(s == null ? '' : s); return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function escAttr(s) { s = String(s == null ? '' : s); return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// highlightDiff 检测代码是否为 diff 格式，若是则对 +/-/@@ 行着色并返回 HTML；
// 若不是 diff 则返回空字符串（调用方回退到普通代码块渲染）。
// code 参数已通过 escHtml 转义。
function highlightDiff(code) {
  var lines = code.split('\n');
  var headers = 0, adds = 0, dels = 0;
  for (var i = 0; i < lines.length; i++) {
    var ch = lines[i].charAt(0);
    var ch2 = lines[i].charAt(1);
    if (ch === '@' && ch2 === '@') headers++;
    if (ch === '+' && ch2 !== '+') adds++;
    if (ch === '-' && ch2 !== '-') dels++;
  }
  // 至少 1 个 @@ 头部，或 3 行以上 +/- 才视为 diff
  if (headers === 0 && adds + dels < 3) return '';

  var result = '';
  for (var j = 0; j < lines.length; j++) {
    var line = lines[j];
    if (/^@@\s+-\d+/.test(line)) {
      result += '<span class="diff-header">' + line + '</span>\n';
    } else if (/^---\s/.test(line) || /^\+\+\+\s/.test(line)) {
      result += '<span class="diff-meta">' + line + '</span>\n';
    } else if (/^\+/.test(line)) {
      result += '<span class="diff-add">' + line + '</span>\n';
    } else if (/^-/.test(line)) {
      result += '<span class="diff-del">' + line + '</span>\n';
    } else {
      result += line + '\n';
    }
  }
  return result.replace(/\n$/, '');
}

// computeLineDiff 对 old/new 两段文本做逐行 LCS diff，返回 [{type:'same'|'del'|'add', text, ln}]
// startLine 为修改区域起始行号（1-based，0 表示未知——此时不附带行号）。
function computeLineDiff(oldStr, newStr, startLine) {
  var oldLines = oldStr.split('\n');
  var newLines = newStr.split('\n');
  var m = oldLines.length, n = newLines.length;

  // LCS DP 表：dp[i][j] = oldLines[0..i-1] 与 newLines[0..j-1] 的最长公共子序列长度
  var dp = new Array(m + 1);
  for (var i = 0; i <= m; i++) {
    dp[i] = new Array(n + 1);
    for (var j = 0; j <= n; j++) {
      if (i === 0 || j === 0) {
        dp[i][j] = 0;
      } else if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯构造 diff 序列（正序）
  var result = [];
  var i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({ type: 'same', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', text: newLines[j - 1] });
      j--;
    } else {
      result.push({ type: 'del', text: oldLines[i - 1] });
      i--;
    }
  }
  result.reverse();

  // 正向计算每行对应的文件行号：del 用 oldLine，add/same 用 newLine（均从 startLine 起）
  if (startLine > 0) {
    var oldLine = startLine, newLine = startLine;
    for (var k = 0; k < result.length; k++) {
      var r = result[k];
      if (r.type === 'del') { r.ln = oldLine; oldLine++; }
      else if (r.type === 'add') { r.ln = newLine; newLine++; }
      else { r.ln = newLine; oldLine++; newLine++; }
    }
  }
  return result;
}

// parseToolInput 安全解析 tool_use.content(JSON 字符串)。失败返回 null，调用方统一走 fallback。
function parseToolInput(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function parseJSONSafe(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function clipText(s, n) {
  s = String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fullText(s) { return String(s == null ? '' : s).trim(); }
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o || {}, k); }
function countTextLines(s) { return String(s || '').length ? String(s || '').split('\n').length : 0; }

function readRangeText(input) {
  if (!input) return '';
  if (input.pages) return 'pages ' + input.pages;
  if (hasOwn(input, 'offset') || hasOwn(input, 'limit')) {
    var off = Number(input.offset || 0);
    var lim = Number(input.limit || 0);
    if (lim > 0) return 'lines ' + (off + 1) + '-' + (off + lim);
    if (off > 0) return 'from line ' + (off + 1);
  }
  return '';
}

function primaryField(input) {
  if (!input) return '';
  var keys = ['file_path','filePath','path','url','image_source','video_source','nodeId','query','search_query','pattern','command','description','skill','subject','taskId','action','operation','name'];
  for (var i = 0; i < keys.length; i++) {
    var v = input[keys[i]];
    if (v != null && v !== '') return clipText(v, 120);
  }
  return '';
}

function buildEditDiffView(oldStr, newStr, startLine, maxRows) {
  oldStr = oldStr || '';
  newStr = newStr || '';
  var oldLines = oldStr.split('\n');
  var newLines = newStr.split('\n');
  var added = 0, removed = 0;
  // 大 diff 避免 LCS O(m*n) 卡住 UI：直接给 old/new 片段预览。
  if (oldLines.length * newLines.length > 40000 || oldStr.length + newStr.length > 60000) {
    added = newLines.length;
    removed = oldLines.length;
    var oldPreview = oldStr.length > 3500 ? oldStr.slice(0, 3500) + '\n...（旧内容过长，已截断）' : oldStr;
    var newPreview = newStr.length > 3500 ? newStr.slice(0, 3500) + '\n...（新内容过长，已截断）' : newStr;
    return {
      added: added,
      removed: removed,
      truncated: true,
      html: '<div class="tool-edit-hint">⚠ 变更较大，已显示 old/new 预览</div>'
        + '<details class="tool-edit-details"><summary>查看旧内容片段</summary><pre class="chat-tool-input-pre">' + escHtml(oldPreview) + '</pre></details>'
        + '<details class="tool-edit-details" open><summary>查看新内容片段</summary><pre class="chat-tool-input-pre">' + escHtml(newPreview) + '</pre></details>'
    };
  }
  var changes = computeLineDiff(oldStr, newStr, startLine || 0);
  for (var i = 0; i < changes.length; i++) {
    if (changes[i].type === 'add') added++;
    else if (changes[i].type === 'del') removed++;
  }
  var limit = (maxRows == null) ? 260 : maxRows;
  var diff = '';
  for (var k = 0; k < changes.length && (limit <= 0 || k < limit); k++) {
    var ch = changes[k];
    var cls = ch.type === 'del' ? 'diff-del' : (ch.type === 'add' ? 'diff-add' : 'diff-same');
    var sign = ch.type === 'del' ? '-' : (ch.type === 'add' ? '+' : ' ');
    var lnHTML = ch.ln ? '<span class="diff-ln">' + ch.ln + '</span>' : '';
    diff += '<div class="' + cls + '">' + lnHTML
      + '<span class="diff-ct">' + sign + ' ' + escHtml(ch.text || ' ') + '</span></div>';
  }
  var truncated = limit > 0 && changes.length > limit;
  if (truncated) diff += '<div class="diff-same"><span class="diff-ct">…（diff 过长，已截断）</span></div>';
  return {
    added: added,
    removed: removed,
    truncated: truncated,
    html: '<div class="tool-edit-diff' + (startLine ? ' has-linenr' : '') + '">' + diff + '</div>'
  };
}

// renderToolCallBody 渲染工具调用的输入体。对 Edit/Write 工具提取 old_string/new_string
// 并渲染为增删行颜色标记（红删绿增）；其他工具回退为 JSON 原文。
// startLine 为 Edit 修改区域起始行号（来自后端定位），>0 时 diff 左侧显示行号列。
function renderToolCallBody(tool, rawContent, startLine) {
  if (tool !== 'Edit' && tool !== 'Write') {
    return '<div class="chat-msg-tool-input">' + escHtml(rawContent) + '</div>';
  }

  // 尝试解析 JSON 输入
  var input = parseToolInput(rawContent);
  if (!input) {
    return '<div class="chat-msg-tool-input">' + escHtml(rawContent) + '</div>';
  }

  // 文件路径已在卡片头部展示，body 不再重复
  var html = '';

  // Write 工具：新建/覆盖整个文件，不直接平铺全部内容，给出提示并可折叠查看
  if (tool === 'Write' && input.content) {
    var lineCount = input.content.split('\n').length;
    var byteLen = input.content.length;
    html += '<div class="tool-edit-hint">📝 新建文件 · ' + lineCount + ' 行 · ' + byteLen + ' 字符</div>';
    var wc = input.content;
    if (wc.length > 8000) wc = wc.slice(0, 8000) + '\n...（内容过长，已截断）';
    html += '<details class="tool-edit-details"><summary>查看文件内容</summary>'
      + '<div class="tool-edit-diff"><pre><code>' + escHtml(wc) + '</code></pre></div></details>';
    return html;
  }

  // Edit 工具：逐行 LCS diff，只标真正变化的行
  var oldStr = input.old_string || '';
  var newStr = input.new_string || '';
  if (!oldStr && !newStr) {
    html += '<div class="chat-msg-tool-input">' + escHtml(rawContent) + '</div>';
    return html;
  }

  var diffView = buildEditDiffView(oldStr, newStr, startLine || 0, 260);
  html += diffView.html;
  return html;
}

// ---- 工具调用卡片（Claude Code 风格：调用+结果合并为一个可折叠卡片）----
// 参考 Claude Code 终端：⏺ 工具名(关键参数) 头部 + ⎿ 结果摘要 + 可展开完整内容。

// toolKeyInfo 按工具名从已解析的 input 提取头部展示信息，返回 {param, path}。
// param 为主参数（括号内展示）；path 为完整路径（独立一行展示，仅路径类工具有）。
// 路径完整保留（不去 basename），文本类参数过长截断到 100 字符。
function toolKeyInfo(tool, input) {
  if (!input) return { param: '', path: '' };
  switch (tool) {
  case 'Read': {
    var p = fullText(input.file_path || input.path);
    var rr = readRangeText(input);
    return { param: p + (rr ? ' · ' + rr : ''), path: '' };
  }
  case 'Write':
  case 'Edit':
    return { param: fullText(input.file_path || input.filePath), path: '' };
  case 'NotebookEdit':
    return { param: fullText(input.notebook_path || input.file_path || input.filePath), path: '' };
  case 'Bash':
    return { param: clipText(input.description || input.command, 120), path: input.description ? clipText(input.command, 160) : '' };
  case 'Grep': {
    var scope = input.path || input.glob || input.type || '';
    var mode = input.output_mode ? (' · ' + input.output_mode) : '';
    return { param: clipText(input.pattern, 120) + mode, path: fullText(scope) };
  }
  case 'Glob':
    return { param: clipText(input.pattern, 120), path: fullText(input.path) };
  case 'Agent':
    return { param: clipText(input.description || input.subagent_type || input.prompt, 120), path: fullText(input.subagent_type) };
  case 'Skill':
    return { param: clipText(input.skill, 100), path: clipText(input.args || '', 160) };
  case 'WebSearch':
    return { param: clipText(input.query, 120), path: '' };
  case 'WebFetch':
    return { param: clipText(input.url, 120), path: clipText(input.prompt, 160) };
  case 'TaskCreate':
    return { param: clipText(input.subject, 120), path: '' };
  case 'TaskUpdate':
  case 'TaskGet':
  case 'TaskStop':
  case 'TaskOutput':
    return { param: input.taskId || input.task_id ? ('#' + (input.taskId || input.task_id) + (input.status ? ' → ' + input.status : '')) : clipText(primaryField(input), 120), path: '' };
  case 'LSP':
    return { param: clipText((input.operation || '') + (input.filePath ? (' · ' + input.filePath + (input.line ? ':' + input.line : '')) : ''), 140), path: '' };
  default:
    return { param: primaryField(input), path: '' };
  }
}

// resultSummary 由工具名 + 结果内容生成一行语义摘要，返回 {text, ok}。
// ok=false 表示失败（红色 ✗）。复刻 Claude Code 的 ⎿ Read N lines / Found N results 风格。
function resultSummary(tool, content, isError, toolUseResult) {
  content = content || '';
  var structured = parseJSONSafe(toolUseResult || '');
  if (isError) {
    var first = (content.split('\n')[0] || '失败').trim();
    return { text: '✗ ' + (first || '失败'), ok: false };
  }
  var arr = content.replace(/\r/g, '').split('\n');
  var nonEmpty = 0;
  for (var i = 0; i < arr.length; i++) if (arr[i].trim()) nonEmpty++;
  function lastNonEmpty() {
    for (var j = arr.length - 1; j >= 0; j--) {
      if (arr[j].trim()) return arr[j].slice(0, 80);
    }
    return '';
  }
  switch (tool) {
  case 'Read':
    return { text: nonEmpty > 0 ? ('读取 ' + nonEmpty + ' 行') : '空内容', ok: true };
  case 'Grep':
    if (structured && structured.numMatches != null) return { text: '命中 ' + structured.numMatches + ' 处' + (structured.numFiles != null ? (' · ' + structured.numFiles + ' 文件') : ''), ok: true };
    return { text: nonEmpty > 0 ? ('找到 ' + nonEmpty + ' 行') : '无结果', ok: true };
  case 'Glob':
    if (structured && structured.numFiles != null) return { text: '匹配 ' + structured.numFiles + ' 个文件', ok: true };
    return { text: nonEmpty > 0 ? ('匹配 ' + nonEmpty + ' 项') : '无结果', ok: true };
  case 'Bash':
    if (structured && structured.stderr) return { text: '✗ ' + clipText(structured.stderr, 80), ok: false };
    var em = /Exit code (\d+)/.exec(content);
    if (em) return { text: '✗ Exit ' + em[1], ok: false };
    if (structured && structured.stdout) return { text: clipText(structured.stdout.split('\n').filter(Boolean).pop() || structured.stdout, 80) || '(no output)', ok: true };
    return { text: lastNonEmpty() || '(no output)', ok: true };
  case 'Write':
    return { text: '已写入', ok: true };
  case 'Edit':
    return { text: '已修改', ok: true };
  case 'NotebookEdit':
    return { text: '已修改 Notebook', ok: true };
  case 'Agent':
    if (structured && structured.totalToolUseCount != null) return { text: '完成 · ' + structured.totalToolUseCount + ' 个工具', ok: true };
    return { text: '完成', ok: true };
  case 'Skill':
    return { text: '已执行 skill', ok: true };
  default:
    return { text: (arr[0] || '').slice(0, 80) || '(empty)', ok: true };
  }
}

// renderToolCard 渲染「调用 + 结果」合并卡片。toolUse 必填；result 为配对的 tool_result，
// 为 null 表示挂起中（AskUserQuestion / 权限请求 / 执行中）。
// Edit/Write 复用 renderToolCallBody 的 diff 视图；其余工具折叠 input 全文。
function renderToolCard(toolUse, result) {
  var tool = toolUse.tool || 'tool';
  var rawInput = toolUse.content || '';
  var input = parseToolInput(rawInput);
  var info = toolKeyInfo(tool, input);

  var html = '<div class="chat-msg chat-tool-card">';
  // 头部：⏺ 工具名(主参数) + 完整路径（路径类工具独占一行）
  html += '<div class="chat-tool-head">'
    + '<span class="chat-tool-dot">⏺</span>'
    + '<span class="chat-tool-name">' + escHtml(tool) + '</span>'
    + (info.param ? '<span class="chat-tool-param">(' + escHtml(info.param) + ')</span>' : '')
    + (info.path ? '<span class="chat-tool-path">' + escHtml(info.path) + '</span>' : '')
    + '</div>';

  // 主体：Edit/Write 走 diff；Skill args 默认折叠；其他折叠 input 全文
  if (tool === 'Edit' || tool === 'Write') {
    html += renderToolCallBody(tool, rawInput, toolUse.editStartLine || 0);
  } else if (tool === 'Skill' && input) {
    var args = input.args || '';
    if (args) {
      html += '<details class="chat-tool-input-expand"><summary>展开 skill 参数</summary>'
        + '<pre class="chat-tool-input-pre">' + escHtml(args) + '</pre></details>';
    }
  } else if (rawInput) {
    html += '<details class="chat-tool-input-expand"><summary>查看调用参数</summary>'
      + '<pre class="chat-tool-input-pre">' + escHtml(rawInput) + '</pre></details>';
  }

  // 结果区
  if (result) {
    var rc = result.content || '';
    var sum = resultSummary(tool, rc, !!result.isError, result.toolUseResult || toolUse.toolUseResult);
    html += '<div class="chat-tool-result ' + (sum.ok ? 'ok' : 'err') + '">'
      + '<span class="chat-tool-result-mark">⎿</span>'
      + '<span class="chat-tool-result-text">' + escHtml(sum.text) + '</span>'
      + '</div>';
    // 长结果折叠完整内容（短结果摘要已足够，不重复展示）
    var lines = rc.replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); }).length;
    if (rc.trim() && (lines > 1 || rc.length > 120)) {
      var full = rc.length > 6000 ? rc.slice(0, 6000) + '\n... (结果过长，已截断)' : rc;
      html += '<details class="chat-tool-result-detail"><summary>查看完整结果</summary>'
        + '<div class="chat-tool-result-full">' + formatRichContent(full) + '</div></details>';
    }
  } else {
    // 无配对结果：挂起中（等待用户选择 / 工具执行中）
    html += '<div class="chat-tool-result pending">'
      + '<span class="chat-tool-result-mark">⎿</span>'
      + '<span class="chat-tool-result-text">⏳ 等待中…</span>'
      + '</div>';
  }

  html += '</div>';
  return html;
}

function isInteractiveTool(tool) {
  return tool === 'AskUserQuestion' || tool === 'ExitPlanMode' || tool === 'EnterPlanMode';
}

function summarizeToolCall(toolUse, result) {
  var tool = toolUse.tool || 'tool';
  var input = parseToolInput(toolUse.content || '');
  var info = toolKeyInfo(tool, input);
  var sum = result ? resultSummary(tool, result.content || '', !!result.isError, result.toolUseResult || toolUse.toolUseResult) : { text: '等待中…', ok: true };
  return {
    tool: tool,
    input: input,
    param: info.param || '',
    path: info.path || '',
    resultText: sum.text || '',
    ok: !!sum.ok,
    pending: !result
  };
}

function pairToolCalls(messages) {
  var resultByToolId = {};
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (m.role === 'tool_result' && m.toolId && !resultByToolId[m.toolId]) resultByToolId[m.toolId] = m;
  }
  var consumed = {};
  var items = [];
  for (var j = 0; j < messages.length; j++) {
    var msg = messages[j];
    if (msg.role === 'tool_use') {
      var matched = (msg.toolId && resultByToolId[msg.toolId]) ? resultByToolId[msg.toolId] : null;
      if (matched) consumed[msg.toolId] = true;
      var item = { kind: 'tool', toolUse: msg, result: matched, index: j };
      item.summary = summarizeToolCall(msg, matched);
      items.push(item);
    } else if (msg.role === 'tool_result') {
      if (msg.toolId && consumed[msg.toolId]) continue;
      items.push({ kind: 'tool_result', message: msg, index: j });
    } else if (msg.role === 'command') {
      items.push({ kind: 'command', message: msg, index: j });
    } else {
      items.push({ kind: 'message', message: msg, index: j });
    }
  }
  return items;
}

function canGroupTool(item) {
  if (!item || item.kind !== 'tool') return false;
  var tool = item.toolUse.tool || '';
  if (!item.result) return false; // pending/permission/ask 必须单独显示
  if (isInteractiveTool(tool)) return false;
  // 文件/代码修改必须保留原来的内联 diff，不压缩进工具组。
  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') return false;
  return true;
}

function buildToolGroups(items) {
  var out = [];
  var buf = [];
  function flush() {
    if (buf.length >= 2) out.push({ kind: 'tool_group', items: buf.slice(), turn: buf[0].toolUse.turn });
    else if (buf.length === 1) out.push(buf[0]);
    buf = [];
  }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (canGroupTool(it)) {
      if (buf.length && buf[0].toolUse.turn !== it.toolUse.turn) flush();
      buf.push(it);
    } else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

function collectChangeEntries(items) {
  var changes = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!it || it.kind !== 'tool') continue;
    var tool = it.toolUse.tool || '';
    if (tool !== 'Edit' && tool !== 'Write' && tool !== 'NotebookEdit') continue;
    var input = parseToolInput(it.toolUse.content || '');
    if (!input) continue;
    var id = 'chg-' + i + '-' + (it.toolUse.toolId || ('idx' + it.index));
    var filePath = input.file_path || input.filePath || input.notebook_path || '';
    var entry = {
      id: id,
      toolId: it.toolUse.toolId || '',
      tool: tool,
      filePath: filePath,
      ts: it.toolUse.ts || 0,
      turn: it.toolUse.turn || 0,
      status: it.result && it.result.isError ? 'error' : (it.result ? 'ok' : 'pending'),
      title: tool + (filePath ? (' · ' + filePath) : ''),
      summary: '',
      previewHTML: '',
      added: 0,
      removed: 0
    };
    if (tool === 'Edit') {
      var oldStr = input.old_string || '';
      var newStr = input.new_string || '';
      var dv = buildEditDiffView(oldStr, newStr, it.toolUse.editStartLine || 0, 0);
      entry.added = dv.added;
      entry.removed = dv.removed;
      entry.summary = '+' + dv.added + ' / -' + dv.removed + (it.toolUse.editStartLine ? (' · line ' + it.toolUse.editStartLine) : '');
      entry.previewHTML = dv.html;
    } else if (tool === 'Write') {
      var content = input.content || '';
      var wc = content.length > 20000 ? content.slice(0, 20000) + '\n...（内容过长，已截断）' : content;
      entry.added = countTextLines(content);
      entry.summary = countTextLines(content) + ' 行 · ' + content.length + ' 字符';
      entry.previewHTML = '<details class="chat-change-write"><summary>📝 新建/覆盖文件 · ' + escHtml(entry.summary) + '</summary>'
        + '<div class="tool-edit-diff chat-change-write-body"><pre><code>' + escHtml(wc) + '</code></pre></div></details>';
    } else if (tool === 'NotebookEdit') {
      var src = input.new_source || input.source || input.content || '';
      var np = src.length > 8000 ? src.slice(0, 8000) + '\n...（内容过长，已截断）' : src;
      entry.summary = (input.edit_mode || 'replace') + (input.cell_id ? (' · cell ' + input.cell_id) : '');
      entry.previewHTML = '<div class="tool-edit-hint">📓 Notebook ' + escHtml(entry.summary) + '</div>'
        + (np ? '<div class="tool-edit-diff"><pre><code>' + escHtml(np) + '</code></pre></div>' : '<div class="chat-change-empty">无可预览内容</div>');
    }
    it.changeId = id;
    changes.push(entry);
  }
  return changes;
}

function buildChatRenderModel(messages) {
  var paired = pairToolCalls(messages || []);
  var changes = collectChangeEntries(paired);
  return { items: buildToolGroups(paired), changes: changes };
}

function renderToolCardWithChange(item) {
  return renderToolCard(item.toolUse, item.result);
}

function renderToolGroupCard(group) {
  var rows = '';
  for (var i = 0; i < group.items.length; i++) {
    var it = group.items[i];
    var s = it.summary || summarizeToolCall(it.toolUse, it.result);
    var changeAttr = it.changeId ? (' data-change-id="' + escAttr(it.changeId) + '" onclick="focusChange(\'' + escAttr(it.changeId) + '\')"') : '';
    var cls = 'chat-tool-row' + (it.changeId ? ' chat-change-link' : '');
    rows += '<div class="' + cls + '"' + changeAttr + '>'
      + '<span class="chat-tool-row-dot">⏺</span>'
      + '<span class="chat-tool-row-name">' + escHtml(s.tool) + '</span>'
      + '<span class="chat-tool-row-main">' + escHtml(s.param || '') + '</span>'
      + (s.path ? '<span class="chat-tool-row-path">' + escHtml(s.path) + '</span>' : '')
      + '<span class="chat-tool-row-result ' + (s.ok ? 'ok' : 'err') + '">⎿ ' + escHtml(s.resultText || '') + '</span>'
      + '</div>';
    if (s.tool === 'Skill' && s.input && s.input.args) {
      rows += '<details class="chat-tool-row-detail"><summary>展开 ' + escHtml(s.input.skill || 'Skill') + ' 参数</summary>'
        + '<pre class="chat-tool-input-pre">' + escHtml(s.input.args) + '</pre></details>';
    }
  }
  return '<div class="chat-msg chat-tool-card chat-tool-group">'
    + '<div class="chat-tool-head"><span class="chat-tool-dot">⏺</span><span class="chat-tool-name">工具调用</span><span class="chat-tool-param">连续 ' + group.items.length + ' 条</span></div>'
    + '<div class="chat-tool-group-list">' + rows + '</div>'
    + '</div>';
}

function markdownSuggestedFilename(m, idx) {
  var ts = m.ts ? new Date(m.ts) : new Date();
  var stamp = ts.getFullYear()
    + String(ts.getMonth() + 1).padStart(2, '0')
    + String(ts.getDate()).padStart(2, '0') + '-'
    + String(ts.getHours()).padStart(2, '0')
    + String(ts.getMinutes()).padStart(2, '0')
    + String(ts.getSeconds()).padStart(2, '0');
  return 'cc-console-message-' + (chatPanelPid || 'session') + '-' + stamp + '-' + idx + '.md';
}

function detectMarkdownPayload(text) {
  if (!text || isAnnotationOnly(text)) return false;
  var t = stripAnsi(text).trim();
  if (!t) return false;
  if (/```[\s\S]*?```/.test(t)) return true;
  if (t.length < 80) return false;
  var score = 0;
  if (/^#{1,6}\s+\S/m.test(t)) score++;
  if (/^(?:[-*]\s+|\d+\.\s+)/m.test(t)) score++;
  if (/^\|.+\|\s*\n\|[\s:?|-]+\|/m.test(t)) score++;
  if (/^>\s+/m.test(t)) score++;
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) score++;
  if (/^(---|\*\*\*|___)$/m.test(t)) score++;
  if (/\n {4}\S/.test(t)) score++;
  return score >= 2;
}

function markdownForSave(text) {
  return stripAnsi(text || '').trim() + '\n';
}

function renderMessageBubble(item) {
  var m = item.message;
  var role = m.role;
  if (role === 'command') {
    // last-prompt 已不再进入消息流；旧缓存/旧后端返回时也隐藏，避免重复显示用户输入。
    return '';
  }
  if (role === 'user' && isAnnotationOnly(m.content || '')) {
    return '<div class="chat-msg chat-msg-event">' + formatRichContent(m.content || '') + '</div>';
  }
  var cls = role === 'user' ? 'chat-msg-user' : 'chat-msg-assistant';
  var label = role === 'user' ? '📝 用户' : '🤖 助手';
  var top = '<span class="chat-msg-label">' + label + '</span>';
  if (detectMarkdownPayload(m.content || '')) {
    var id = 'md-' + item.index;
    markdownDownloads[id] = { filename: markdownSuggestedFilename(m, item.index), content: markdownForSave(m.content || '') };
    top = '<div class="chat-msg-top"><span class="chat-msg-label">' + label + '</span>'
      + '<button class="chat-msg-download-btn" title="保存为 Markdown 文件" onclick="downloadMarkdownMessage(\'' + escAttr(id) + '\')">'
      + '<svg class="chat-msg-download-icon" viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M12 3v11"></path><path d="M7.5 9.5 12 14l4.5-4.5"></path><path d="M5 19h14"></path>'
      + '</svg><span>下载md文件</span></button></div>';
  }
  return '<div class="chat-msg ' + cls + '">' + top + formatRichContent(m.content || '') + '</div>';
}

function renderOrphanToolResult(m) {
  var rt = m.content || '';
  if (rt.length > 6000) rt = rt.slice(0, 6000) + '\n... (结果过长，已截断)';
  return '<div class="chat-msg chat-msg-tool-result">'
    + '<span class="chat-msg-label">📋 工具结果' + (m.isError ? ' · 失败' : '') + '</span>'
    + formatRichContent(rt)
    + '</div>';
}

// ---- Markdown 格式化 ----
// buildTable 把 GFM 表格的若干原始行（已转义）渲染成 <table>。
// rows[0]=表头行，rows[1]=分隔行（决定对齐），其余=数据行。
function buildTable(rows) {
  function parseCells(rowLine) {
    var inner = rowLine.replace(/^\|/, '').replace(/\|\s*$/, '');
    return inner.split('|').map(function(c) { return c.trim(); });
  }
  function alignOf(s) {
    if (/^:-+$/.test(s)) return 'left';
    if (/^-+:$/.test(s)) return 'right';
    if (/^:-+:$/.test(s)) return 'center';
    return '';
  }
  var header = parseCells(rows[0]);
  var aligns = parseCells(rows[1]).map(alignOf);
  function cellTag(tag, content, idx) {
    var a = aligns[idx];
    var style = a ? ' style="text-align:' + a + '"' : '';
    return '<' + tag + style + '>' + (content == null ? '' : content) + '</' + tag + '>';
  }
  var t = '<table class="md-table"><thead><tr>';
  header.forEach(function(c, idx) { t += cellTag('th', c, idx); });
  t += '</tr></thead><tbody>';
  var ncols = header.length;
  for (var r = 2; r < rows.length; r++) {
    var cells = parseCells(rows[r]);
    t += '<tr>';
    for (var c = 0; c < ncols; c++) { t += cellTag('td', cells[c], c); }
    t += '</tr>';
  }
  t += '</tbody></table>';
  return t;
}

// renderMarkdown 把文本中的常见 markdown 语法转为 HTML。
// 调用方负责保证输入不含未闭合的 Claude Code 注解标签（即注解标签已先由
// formatRichContent 处理完毕）。函数内部先做 HTML 转义，再转换 markdown。
function renderMarkdown(text) {
  if (!text) return '';
  var html = escHtml(text);

  // 保护围栏代码块：```lang\n...\n```，避免内部 **、* 等被误转
  var fenced = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function(_, lang, code) {
    var idx = fenced.length;
    var content = code.replace(/\n$/, '');
    var diffHTML;
    // diff/patch 语言标记，或自动检测内容是否匹配 diff 格式
    if (lang === 'diff' || lang === 'patch') {
      diffHTML = highlightDiff(content);
    } else if (!lang) {
      diffHTML = highlightDiff(content); // 无语言标记时自动检测
    }
    if (diffHTML) {
      fenced.push('<pre class="diff-block"><code>' + diffHTML + '</code></pre>');
    } else {
      fenced.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + content + '</code></pre>');
    }
    return '\x00F' + idx + '\x00';
  });

  // 保护行内代码：`...`
  var inlined = [];
  html = html.replace(/`([^`\n]+)`/g, function(_, code) {
    var idx = inlined.length;
    inlined.push('<code>' + code + '</code>');
    return '\x00I' + idx + '\x00';
  });

  // 粗体 + 斜体（粗斜体优先，避免 *** 被错拆）
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<em>$1</em>');

  // 链接 [text](url) —— 不用 target="_blank"（会在 WebView2 内弹窗），点击由
  // .chat-body 上的事件委托拦截，转交 OpenURL 用系统默认浏览器打开。
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener">$1</a>');

  // 逐行处理块级元素，构建为单个字符串避免 out.join 引入多余 \n
  var lines = html.split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var m;

    if ((m = /^### (.+)$/.exec(line)))  { out.push('<h3>' + m[1] + '</h3>'); continue; }
    if ((m = /^## (.+)$/.exec(line)))   { out.push('<h2>' + m[1] + '</h2>'); continue; }
    if ((m = /^# (.+)$/.exec(line)))    { out.push('<h1>' + m[1] + '</h1>'); continue; }

    if (/^(---|\*\*\*|___)$/.test(line)) { out.push('<hr>'); continue; }

    // 表格：首行 |...| + 第二行分隔行 |---|---|
    if (/^\|.+\|\s*$/.test(line) && i + 1 < lines.length &&
        /^\|[\s:?|-]+$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      var trows = [line, lines[i + 1]];
      var ti = i + 2;
      while (ti < lines.length && /^\|.+\|\s*$/.test(lines[ti])) {
        trows.push(lines[ti]);
        ti++;
      }
      out.push(buildTable(trows));
      i = ti - 1;
      continue;
    }

    // 无序列表：- / * 开头，连续行拼成单个 <ul> 字符串
    if ((m = /^[\-*] (.+)$/.exec(line))) {
      var ul = '<ul><li>' + m[1] + '</li>';
      i++;
      while (i < lines.length && (m = /^[\-*] (.+)$/.exec(lines[i]))) {
        ul += '<li>' + m[1] + '</li>';
        i++;
      }
      ul += '</ul>';
      out.push(ul);
      i--;
      continue;
    }

    // 有序列表：1. 开头，连续行拼成单个 <ol> 字符串
    if ((m = /^\d+\. (.+)$/.exec(line))) {
      var ol = '<ol><li>' + m[1] + '</li>';
      i++;
      while (i < lines.length && (m = /^\d+\. (.+)$/.exec(lines[i]))) {
        ol += '<li>' + m[1] + '</li>';
        i++;
      }
      ol += '</ol>';
      out.push(ol);
      i--;
      continue;
    }

    // 引用块：>  开头（已转义为 &gt;），连续行拼成单个 <blockquote> 字符串
    if ((m = /^&gt; ?(.+)$/.exec(line))) {
      var bq = '<blockquote>' + m[1];
      i++;
      while (i < lines.length && (m = /^&gt; ?(.+)$/.exec(lines[i]))) {
        bq += '<br>' + m[1];
        i++;
      }
      bq += '</blockquote>';
      out.push(bq);
      i--;
      continue;
    }

    out.push(line);
  }
  html = out.join('\n');

  // 清理块级标签前后的多余换行——chat-msg 有 white-space:pre-wrap，
  // 这些 \n 会被渲染为额外的空行，而块级元素本身就换行
  html = html.replace(/(^|\n)(<(?:h[1-6]|ul|ol|blockquote|hr|div)\b[^>]*>)/g, '$2');
  html = html.replace(/(<\/(?:h[1-6]|ul|ol|blockquote|div)>)(\n|$)/g, '$1');

  // 还原代码块
  html = html.replace(/\x00F(\d+)\x00/g, function(_, idx) { return fenced[+idx]; });
  html = html.replace(/\x00I(\d+)\x00/g, function(_, idx) { return inlined[+idx]; });

  return html;
}

// ---- Claude Code 注解标签格式化 ----
// Claude Code 在消息文本里嵌入伪 XML 注解（斜杠命令、系统提示、任务通知、摘录等），
// 直接显示尖括号原文很突兀。formatRichContent 把已知标签渲染成带样式的结构化块，
// 未知标签（含代码里的 <…>）按普通文本转义，不破坏源码。

// 去除终端 ANSI 颜色转义（命令输出里常见，否则显示 [1m 乱码）。
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*m/g, ''); }

// 已知容器标签 → 渲染类型。
var CC_BLOCK_TAGS = {
  'command-name':'cmd', 'command-message':'cmd', 'command-args':'cmd', 'command-body':'cmd',
  'local-command-stdout':'cmdout', 'local-command-stderr':'cmderr', 'local-command-caveat':'cmdcaveat',
  'system-reminder':'system', 'env':'env', 'user-memory-content':'memory',
  'task-notification':'task', 'task-reminder':'task',
  'persisted-output':'persisted',
  'excerpt':'quote',
  'bash-input':'bashin','bash-stdout':'bashout','bash-stderr':'basherr',
  'thinking':'think','antThinking':'think',
};
// 全部已知标签名（供残片兜底正则用）。
var CC_TAG_ALT = 'command-name|command-message|command-args|command-body|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|env|user-memory-content|task-notification|task-reminder|persisted-output|excerpt|bash-input|bash-stdout|bash-stderr|thinking|antThinking';

// grabTag 从 content 中提取某标签的纯文本内文。
function grabTag(content, tag) {
  var m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(content);
  return m ? m[1].replace(/^\n+|\n+$/g, '') : '';
}

// renderCommandCard 渲染斜杠命令卡片。command-body 默认折叠，避免 skill/命令展开内容占满屏幕。
function renderCommandCard(o) {
  var line = (o.n || '') + (o.a ? (' ' + o.a) : '');
  var html = '<div class="cc-cmd-card"><div class="cc-cmd"><span class="cc-cmd-icon">⌘</span><code>' + escHtml(line) + '</code></div>';
  if (o.b) {
    html += '<details class="cc-cmd-detail"><summary>展开命令内容</summary><pre class="cc-cmd-body">' + escHtml(o.b) + '</pre></details>';
  }
  html += '</div>';
  return html;
}

// renderTask 渲染任务通知：解析内嵌 status/summary。
function renderTask(content) {
  var status = grabTag(content, 'status');
  var summary = grabTag(content, 'summary');
  var cls = (status === 'success' || status === 'completed') ? 'ok'
    : (status === 'failed' || status === 'error') ? 'fail' : '';
  var icon = cls === 'ok' ? '✅' : cls === 'fail' ? '❌' : '🔔';
  var h = '<div class="cc-task' + (cls ? (' cc-task-' + cls) : '') + '">'
    + icon + ' <span class="cc-task-label">后台任务' + (status ? (' · ' + escHtml(status)) : '') + '</span>';
  if (summary) h += '<div class="cc-task-summary">' + escHtml(summary) + '</div>';
  h += '</div>';
  return h;
}

// renderBlock 把单个已知标签的内文渲染成对应结构化块。
function renderBlock(name, content) {
  var body = content.replace(/^\n+|\n+$/g, '');
  switch (CC_BLOCK_TAGS[name]) {
  case 'cmd': return renderCommandCard({ n: body });
  case 'cmdout': return '<pre class="cc-cmdout">' + escHtml(body) + '</pre>';
  case 'cmderr': return '<pre class="cc-cmderr">' + escHtml(body) + '</pre>';
  case 'cmdcaveat': return '<div class="cc-caveat">⚠ ' + escHtml(body) + '</div>';
  case 'system': return '<div class="cc-block cc-system"><span class="cc-label">系统</span>' + renderMarkdown(body) + '</div>';
  case 'env': return '<div class="cc-block cc-system"><span class="cc-label">环境</span>' + escHtml(body) + '</div>';
  case 'memory': return '<div class="cc-block cc-system"><span class="cc-label">记忆</span>' + formatRichContent(content) + '</div>';
  case 'task': return renderTask(content);
  case 'persisted': return '<div class="cc-persisted">📎 ' + escHtml(body) + '</div>';
  case 'quote': return '<blockquote class="cc-quote">' + formatRichContent(content) + '</blockquote>';
  case 'bashin': return '<pre class="cc-bashin">$ ' + escHtml(body) + '</pre>';
  case 'bashout': return '<pre class="cc-cmdout">' + escHtml(body) + '</pre>';
  case 'basherr': return '<pre class="cc-cmderr">' + escHtml(body) + '</pre>';
  case 'think': return '<details class="cc-think"><summary>💭 思考过程</summary><div>' + formatRichContent(content) + '</div></details>';
  default: return escHtml(content); // 未知标签：剥外壳留内文
  }
}

// formatRichContent 把含 Claude Code 注解标签的文本渲染成 HTML（未知/代码标签按文本转义）。
function formatRichContent(text) {
  if (!text) return '';
  text = stripAnsi(text);
  // 先合并斜杠命令 name(+message)(+args)(+body) 为一个命令卡片标记（\u0000CMD{json}\u0000），
  // command-body 默认折叠，避免 /skill 展开的完整 prompt 占满消息流。
  text = text.replace(
    /<command-name>([\s\S]*?)<\/command-name>\s*(?:<command-message>[\s\S]*?<\/command-message>\s*)?(?:<command-args>([\s\S]*?)<\/command-args>\s*)?(?:<command-body>([\s\S]*?)<\/command-body>\s*)?/g,
    function (_, n, a, b) { return '\u0000CMD' + JSON.stringify({ n: n.trim(), a: (a || '').trim(), b: (b || '').replace(/^\n+|\n+$/g, '') }) + '\u0000'; }
  );
  var html = '';
  var i = 0;
  var tagRe = /^<([a-zA-Z][\w-]*)\b[^>]*?\/?>/;
  while (i < text.length) {
    // 命令卡片标记
    if (text.charAt(i) === '\u0000' && text.substr(i, 4) === '\u0000CMD') {
      var end = text.indexOf('\u0000', i + 4);
      if (end < 0) { html += renderMarkdown(text.slice(i)); break; }
      try { html += renderCommandCard(JSON.parse(text.slice(i + 4, end))); } catch (e) { /* 跳过 */ }
      i = end + 1;
      continue;
    }
    // 从 i 起向后扫描第一个「已知注解标签」的 <；途中的非已知 <（代码/正文里的 < 等）
    // 一律视为普通文本，不在此切分——它们连同前后文本整体交给 renderMarkdown，< 由
    // escHtml 转义为 &lt;。切分会破坏表格等跨多行 markdown 结构（行被截断后不再以 |
    // 结尾，数据行匹配失败，导致只渲染表头）。
    // 关键：只推进临时扫描指针 scan，不移动 i——原先遇到非已知 < 直接 i=lt+1 会把 <
    // 及其之前的整段文本永久丢弃（消息含 `<pid>` 这类时首段直接消失），这是回归根因。
    var tagAt = -1, mOpen = null, scan = i;
    while (true) {
      var lt = text.indexOf('<', scan);
      if (lt < 0) break;
      var mm = tagRe.exec(text.slice(lt));
      if (mm && CC_BLOCK_TAGS[mm[1]]) { tagAt = lt; mOpen = mm; break; }
      scan = lt + 1; // 非已知标签：跳过继续找，不丢文本
    }
    if (tagAt < 0) { html += renderMarkdown(text.slice(i)); break; } // 无更多已知标签
    html += renderMarkdown(text.slice(i, tagAt)); // 标签前文本（含途中所有非已知 <）
    var name = mOpen[1];
    var afterOpen = tagAt + mOpen[0].length;
    var close = '</' + name + '>';
    var ci = text.indexOf(close, afterOpen);
    var content, eend;
    if (ci >= 0) { content = text.slice(afterOpen, ci); eend = ci + close.length; }
    else { content = text.slice(afterOpen); eend = text.length; } // 无闭合：取到结尾
    html += renderBlock(name, content);
    i = eend;
  }
  return html;
}

// isAnnotationOnly 判断消息是否"纯注解"（命令/系统/任务事件，无人类真实文本）。
// 此类消息渲染为居中事件行而非左右气泡。
function isAnnotationOnly(text) {
  if (!text) return false;
  if (!new RegExp('<(?:' + CC_TAG_ALT + ')\\b').test(text)) return false;
  var t = stripAnsi(text);
  // 移除命令三件套（name..args 或 name..name）
  t = t.replace(/<command-name>[\s\S]*?(?:<\/command-args>|<\/command-name>)/g, '');
  // 移除各 remove 标签（含内容），用反向引用配对开闭
  t = t.replace(/<(system-reminder|env|user-memory-content|task-notification|task-reminder|persisted-output|local-command-caveat|local-command-stdout|local-command-stderr|command-message|command-args|command-body|thinking|antThinking)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  // 剥 excerpt/bash 外壳
  t = t.replace(/<\/?(excerpt|bash-input|bash-stdout|bash-stderr)\b[^>]*>/g, '');
  // 残片兜底
  t = t.replace(new RegExp('<\\/?(?:' + CC_TAG_ALT + ')\\b[^>]*>', 'g'), '');
  return t.replace(/\s/g, '').length === 0;
}

// ---- 输入历史导航：↑/↓ 在 #chat-input 中切换历史消息 ----

// cleanChatHistoryText 复刻 isAnnotationOnly 的注解清洗，但返回清洗后的纯文本（而非布尔）。
// 供输入历史导航提取 user 消息的可读文本：去掉 system-reminder/env/命令三件套等噪音，
// 只保留人类真实输入。清洗后为空的消息不计入历史。
function cleanChatHistoryText(text) {
  if (!text) return '';
  var t = stripAnsi(text);
  // 移除命令三件套（name..args 或 name..name）
  t = t.replace(/<command-name>[\s\S]*?(?:<\/command-args>|<\/command-name>)/g, '');
  // 移除各 remove 标签（含内容），用反向引用配对开闭
  t = t.replace(/<(system-reminder|env|user-memory-content|task-notification|task-reminder|persisted-output|local-command-caveat|local-command-stdout|local-command-stderr|command-message|command-args|command-body|thinking|antThinking)\b[^>]*>[\s\S]*?<\/\1>/g, '');
  // 剥 excerpt/bash 外壳（保留内文）
  t = t.replace(/<\/?(excerpt|bash-input|bash-stdout|bash-stderr)\b[^>]*>/g, '');
  // 残片兜底
  t = t.replace(new RegExp('<\\/?(?:' + CC_TAG_ALT + ')\\b[^>]*>', 'g'), '');
  return t.replace(/\r/g, '').trim();
}

// collectChatHistory 合并「对话历史里的 user 真实消息」与「发送历史栈」，按文本去重，
// 返回从旧到新的数组。user content 已是纯文本（Go 端 parseContentBlocks 拆分），但可能
// 混 system-reminder 等注解，故经 cleanChatHistoryText 清洗；纯注解消息由 isAnnotationOnly 排除。
function collectChatHistory() {
  var seen = Object.create(null), list = [];
  for (var i = 0; i < lastChatMessages.length; i++) {
    var m = lastChatMessages[i];
    if (m.role !== 'user' || isAnnotationOnly(m.content || '')) continue;
    var t = cleanChatHistoryText(m.content || '');
    if (t && !seen[t]) { seen[t] = 1; list.push(t); }
  }
  for (var j = 0; j < chatSendHistory.length; j++) {
    var s = chatSendHistory[j];
    if (s && !seen[s]) { seen[s] = 1; list.push(s); }
  }
  return list;
}

// navigateChatHistory 按 dir（-1=↑向旧，+1=↓向新）切换 #chat-input 内容到历史项。
// 沿用终端 shell history 语义：↑看更早、↓回到更新，越过最新回到进入前的草稿。
function navigateChatHistory(dir) {
  var input = document.getElementById("chat-input");
  if (!input) return;
  var list = collectChatHistory();
  if (list.length === 0) return; // 无历史，不进入导航
  if (chatHistoryIdx === -1) {
    chatHistoryDraft = input.value; // 进入导航前保存当前草稿
    chatHistoryIdx = list.length;   // 指向「最新之后」= 空输入/草稿
  }
  chatHistoryIdx += dir;
  if (chatHistoryIdx < 0) chatHistoryIdx = 0; // 到顶停住
  if (chatHistoryIdx > list.length) chatHistoryIdx = list.length; // 到底停住
  var text = (chatHistoryIdx === list.length) ? chatHistoryDraft : list[chatHistoryIdx];
  chatHistoryFilling = true; // 程序化设值会同步触发 input，置位防 onChatHistoryInput 误判脱离
  input.value = text;
  chatHistoryFilling = false;
  input.scrollTop = input.scrollHeight; // 多行历史项滚到底
  var pos = text.length;
  try { input.setSelectionRange(pos, pos); } catch (e) { /* 旧浏览器兜底 */ }
}

// onChatHistoryKey 绑在 #chat-input 的 keydown：↑/↓ 触发历史导航。
// 让步规则：斜杠补全菜单展开时让出（归补全导航）；IME 组词中不拦截；
// 多行编辑时光标不在首/末行时放行默认行间移动，避免劫持方向键。
function onChatHistoryKey(e) {
  if (slashOpen) return;     // 斜杠补全优先
  if (e.isComposing) return; // 中文输入法组词中
  var key = e.key;
  if (key !== "ArrowUp" && key !== "ArrowDown") return;
  var el = e.currentTarget;
  var caret = el.selectionStart || 0;
  if (key === "ArrowUp") {
    // 仅当光标在第一行（前面无换行）才导航，否则让光标上移
    if (el.value.substring(0, caret).indexOf("\n") !== -1) return;
  } else {
    // 仅当光标在最后一行（后面无换行）才导航
    if (el.value.substring(caret).indexOf("\n") !== -1) return;
  }
  e.preventDefault();
  navigateChatHistory(key === "ArrowUp" ? -1 : 1);
}

// onChatHistoryInput 绑在 #chat-input 的 input：用户手动编辑（非导航填充）即视为脱离历史，
// 重置导航索引；草稿由 saveChatDraft 自然跟进。
function onChatHistoryInput() {
  if (chatHistoryFilling) return; // 导航填充触发，不脱离
  chatHistoryIdx = -1;
}

// ---- Display helpers ----
function statusEmoji(s) {
  if (s === "busy") return "🔴";
  if (s === "idle") return "🟢";
  return "⚪";
}

function statusLabel(s) {
  if (s === "busy") return "忙碌";
  if (s === "idle") return "空闲";
  return "未知";
}

function modelDisplay(inst) {
  if (!inst.hasConversation) return "（新）";
  if (!inst.model) return "—";
  return inst.model;
}

function topicDisplay(inst) {
  if (!inst.hasConversation) return "（新会话·无消息）";
  if (!inst.topic) return "（暂无主题）";
  return inst.topic;
}

// 分支展示：有 git 分支返回 "🌿 <branch>"，无仓库/无分支返回空串（前端 :empty 自动隐藏）。
function branchDisplay(inst) {
  if (!inst.gitBranch) return "";
  return "🌿 " + inst.gitBranch;
}

function outputDisplay(inst) {
  if (!inst.hasConversation) return "（新）";
  return formatTokens(inst.outputTokens);
}

function totalTokensDisplay(inst) {
  // 只显示 token 明细(in/out/cache,来自 jsonl);无累计数据时显示横杠
  var tin = inst.totalInputTokens || 0;
  var tout = inst.totalOutputTokens || 0;
  var tcache = inst.totalCacheTokens || 0;
  var total = tin + tout + tcache;
  if (total <= 0) return "—";
  return formatTokens(total) + " (in: " + formatTokens(tin) + ", out: " + formatTokens(tout) + ", cache: " + formatTokens(tcache) + ")";
}

// chatTokensDisplay 用于聊天面板底部 Tokens 信息:显示累计 token 明细(in/out/cache,
// 来自 jsonl),无累计数据时显示横杠。
function chatTokensDisplay(inst) {
  var tin = inst.totalInputTokens || 0;
  var tout = inst.totalOutputTokens || 0;
  var tcache = inst.totalCacheTokens || 0;
  var total = tin + tout + tcache;
  if (total > 0) {
    return formatTokens(total) + " (in: " + formatTokens(tin) + ", out: " + formatTokens(tout) + ", cache: " + formatTokens(tcache) + ")";
  }
  return "—";
}

// ---- 主题行右侧：会话动态信息 ----
function lastQueryDisplay(inst) {
  if (!inst.hasConversation || !inst.lastUserQuery) return "";
  return "📝 " + inst.lastUserQuery;
}
function turnsDisplay(inst) {
  if (!inst.hasConversation || !inst.turns) return "";
  return "🔄 " + inst.turns;
}
function toolDisplay(inst) {
  if (!inst.hasConversation || !inst.lastTool) return "";
  return "🔧 " + inst.lastTool;
}
// 最近助手回复挂 tooltip（hover 最近提问区显示）
function lastQueryTitle(inst) {
  if (!inst.hasConversation || !inst.lastReplySnip) return "";
  return "🤖 " + inst.lastReplySnip;
}

// ---- 对话历史区域 ----
function historyHTML(inst) {
  if (!inst.hasConversation) return "";
  if (!inst.history || inst.history.length === 0) {
    var msg = inst.bridgeConnected ? '📡 实时接入中 · 完整对话记录在会话结束后归档' : '（暂无对话记录）';
    return '<div class="card-history card-history-empty">'
      + '<span class="history-empty-msg">' + msg + '</span>'
      + '</div>';
  }
  var header = '<div class="history-header">'
    + '<span class="history-turns">🔄 ' + (inst.turns || inst.history.length) + ' 轮对话</span>';
  if (inst.lastTool) {
    header += ' · <span class="history-tool">🔧 ' + escHtml(inst.lastTool) + '</span>';
  }
  header += '<span class="history-header-spacer"></span>';
  header += '<button class="history-expand-btn" onclick="event.stopPropagation(); openChatPanel(' + inst.pid + ')" title="展开完整会话">⛶</button>';
  header += '</div>';
  // 卡片只展示最新一轮（提问 + 回复各一行，超出省略），更多记录点「对话」或 ⛶ 进入面板查看
  var items = '';
  var last = inst.history.length - 1;
  if (last >= 0) {
    var t = inst.history[last];
    items += '<div class="history-turn">'
      + '<div class="history-q" title="' + escAttr(t.q || "") + '">📝 ' + escHtml(t.q || "") + '</div>'
      + '<div class="history-r" title="' + escAttr(t.r || "") + '">🤖 ' + escHtml(t.r || "") + '</div>'
      + '</div>';
  }
  return '<div class="card-history" data-hist-hash="' + (inst.historyHash || 0) + '">' + header + items + '</div>';
}

function contextBar(inst) {
  if (!inst.hasConversation) return "（新会话）";
  if (inst.contextTokens <= 0) return "—";
  if (inst.contextLimit > 0) {
    var pct = Math.round(inst.contextTokens * 100 / inst.contextLimit);
    return unicodeBar(pct, 22);
  }
  return compactK(inst.contextTokens);
}

function contextBarClass(inst) {
  if (!inst.hasConversation || inst.contextTokens <= 0 || inst.contextLimit <= 0) return "";
  var pct = inst.contextTokens * 100 / inst.contextLimit;
  if (pct < 50) return "";
  if (pct < 80) return "mid";
  return "high";
}

// ---- GLM 账号配额（chat-stats 第三组，账号级全局，与实例解耦）----

// quotaBarClass 按配额用量分档配色：撞 5h token 上限会硬停工作，阈值比 context 更激进。
function quotaBarClass(pct) {
  if (pct < 70) return "";
  if (pct < 90) return "mid";
  return "high";
}

// quotaCountdownText 把下次重置时刻格式化为紧凑倒计时文案（每秒随 renderChatStats 刷新）。
// 不带「后重置」后缀、单位间无空格，并支持天（周限额倒计时可达数天）。5h 与周限额共用。
function quotaCountdownText(nextResetMs) {
  if (!nextResetMs) return "";
  var ms = nextResetMs - Date.now();
  if (ms <= 0) return "即将重置";
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600); s -= h * 3600;
  var m = Math.floor(s / 60); s -= m * 60;
  if (h >= 24) {
    var d = Math.floor(h / 24);
    var rh = h % 24;
    return d + "d" + (rh > 0 ? rh + "h" : "");
  }
  if (h > 0) return h + "h" + m + "m";
  if (m > 0) return m + "m" + s + "s";
  return s + "s";
}

// renderQuotaBar 就地更新配额胶囊条，复用 ctx-progress 形状/配色（CSS 仅缩窄尺寸）。
function renderQuotaBar(el, pct, cls) {
  if (!el) return;
  var fill = el.querySelector(".ctx-progress-fill");
  if (!fill) {
    el.innerHTML = '<span class="ctx-progress-track"><span class="ctx-progress-fill"></span></span>';
    fill = el.querySelector(".ctx-progress-fill");
  }
  el.className = "ctx-progress" + (cls ? " " + cls : "");
  if (fill) fill.style.width = Math.min(100, Math.max(0, pct)) + "%";
}

// balanceDisplay 把 DeepSeek 余额格式化为带币种符号的文本（CNY→¥，否则用 currency code）。
function balanceDisplay(b) {
  if (!b || !b.total) return "—";
  var sym = b.currency === "CNY" ? "¥" : (b.currency ? b.currency + " " : "");
  return sym + b.total;
}

// balanceTooltip 拼接 DeepSeek 余额明细（赠送/充值拆分），挂百分比元素 title。
function balanceTooltip(b) {
  if (!b) return "";
  var sym = b.currency === "CNY" ? "¥" : "";
  var parts = [];
  if (b.granted) parts.push("赠送 " + sym + b.granted);
  if (b.toppedUp) parts.push("充值 " + sym + b.toppedUp);
  return parts.join(" · ");
}

function contextPct(inst) {
  if (!inst.hasConversation || inst.contextTokens <= 0 || inst.contextLimit <= 0) return "";
  return Math.round(inst.contextTokens * 100 / inst.contextLimit) + "%";
}

function contextDetail(inst) {
  if (!inst.hasConversation || inst.contextTokens <= 0) return "";
  if (inst.contextLimit > 0) return compactK(inst.contextTokens) + "/" + compactK(inst.contextLimit);
  return compactK(inst.contextTokens);
}

function unicodeBar(pct, width) {
  pct = Math.max(0, Math.min(100, pct));
  var filled = Math.floor(pct * width / 100);
  if (pct > 0 && filled === 0) filled = 1;
  var bar = "";
  for (var i = 0; i < width; i++) {
    bar += i < filled ? "━" : "─";
  }
  return bar;
}

function compactK(n) {
  if (n >= 1000000) return Math.floor(n / 1000000) + "M";
  if (n >= 1000) return Math.floor(n / 1000) + "k";
  return String(n);
}

function formatTokens(n) {
  if (n <= 0) return "—";
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "—";
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  if (m < 60) return m + " 分";
  var h = Math.floor(m / 60);
  return h + " 小时 " + (m % 60) + " 分";
}

function humanDuration(fromMs) {
  if (!fromMs || fromMs <= 0) return "—";
  var d = Date.now() - fromMs;
  if (d < 0) return "—";
  var sec = Math.floor(d / 1000);
  if (sec < 60) return sec + " 秒";
  if (sec < 3600) return Math.floor(sec / 60) + " 分钟";
  if (sec < 86400) return Math.floor(sec / 3600) + " 小时 " + Math.floor((sec % 3600) / 60) + " 分";
  return Math.floor(sec / 86400) + " 天 " + Math.floor((sec % 86400) / 3600) + " 小时";
}

// ---- Footer ----
function updateFooter(live, stats) {
  var el = document.getElementById("foot-msg");
  if (!footTimer) {
    if (live.length === 0) {
      el.textContent = "待机中 · 没有运行中的实例";
    } else {
      el.textContent = "正在监控 " + live.length + " 个实例 · 每 1 秒刷新";
    }
    el.className = "foot-msg";
  }
}

function flashFoot(msg) {
  var el = document.getElementById("foot-msg");
  el.textContent = msg;
  el.className = "foot-msg fresh";
  if (footTimer) clearTimeout(footTimer);
  footTimer = setTimeout(function() {
    el.className = "foot-msg fading";
    footTimer = setTimeout(function() {
      el.className = "foot-msg";
      footTimer = null;
    }, 1500);
  }, 3000);
}

// ---- 通用确认对话框（替代原生 confirm）----
// macOS WKWebView 未实现 JS dialog UI delegate，原生 confirm() 静默返回 false，
// 导致所有「先确认再执行」的操作（关闭/清空/下载更新）在 mac 上点击无反应（!confirm() 恒真 → return）。
// 改用自定义 modal 返回 Promise<boolean>，跨平台一致；alert 同理静默，错误统一走 flashFoot。
var confirmResolveFn = null;
function confirmDialog(msg, title) {
  return new Promise(function(resolve) {
    // 重入保护：若上一次 confirm 仍未结算（如确认框被遮挡、用户再次触发同一动作），
    // 先把旧的按"取消"结算，避免 confirmResolveFn 被覆盖后旧 Promise 永不 settle、调用方永久挂起。
    if (confirmResolveFn) { confirmResolveFn(false); confirmResolveFn = null; }
    confirmResolveFn = resolve;
    document.getElementById("confirm-msg").textContent = msg;
    document.getElementById("confirm-title").textContent = title || "请确认";
    document.getElementById("confirm-overlay").classList.remove("hidden");
  });
}
window.confirmOk = function() {
  document.getElementById("confirm-overlay").classList.add("hidden");
  if (confirmResolveFn) { confirmResolveFn(true); confirmResolveFn = null; }
};
window.confirmCancel = function() {
  document.getElementById("confirm-overlay").classList.add("hidden");
  if (confirmResolveFn) { confirmResolveFn(false); confirmResolveFn = null; }
};

// ---- Action Handlers ----
window.handleClear = async function(pid) {
  if (!(await confirmDialog("确定要清空 PID " + pid + " 的会话吗？\n此操作将清除当前对话内容。", "清空会话对话"))) return;
  try {
    await Call.ByID(ID_ACT_CLEAR, pid);
    flashFoot("✓  已向 PID " + pid + " 发送 /clear");
  } catch (e) {
    flashFoot("❌ 清空失败: " + (e && e.message ? e.message : e));
  }
};

window.handlePrompt = function(pid) {
  promptTargetPid = pid;
  loadSlashSuggestions(pid); // 预载斜杠命令/技能供消息框补全
  var overlay = document.getElementById("prompt-overlay");
  var input = document.getElementById("prompt-input");
  overlay.classList.remove("hidden");
  input.value = "";
  input.focus();
};

window.handleShowWin = async function(pid) {
  try {
    await Call.ByID(ID_ACT_SHOW, pid);
    flashFoot("🪟  已将 PID " + pid + " 的窗口置前");
  } catch (e) {
    flashFoot("❌ 操作失败: " + (e && e.message ? e.message : e));
  }
};

window.handleCloseSession = async function(e, pid) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (closingPids[pid]) return;
  var meta = instanceMeta[pid] || {};
  var title = meta.topic || ('PID ' + pid);
  var msg = '确定要关闭这个 Claude Code 会话吗？\n\n'
    + title + '\nPID ' + pid + '\n\n'
    + '确认后会先终止对应 Claude Code 进程，然后尽量关闭对应的终端窗口。'
    + '\n如果终端宿主可能是 Windows Terminal 多标签或 IDE 共享窗口，会为了安全保留。';
  if (!(await confirmDialog(msg, "关闭 Claude Code 会话"))) return;
  closingPids[pid] = true;
  sessionTabsSig = '';
  renderSessionTabs();
  try {
    var resultMsg = await Call.ByID(ID_ACT_CLOSE_INSTANCE, pid);
    flashFoot('🛑  ' + (resultMsg || ('已关闭 PID ' + pid + ' 的 Claude Code')));
    await refresh();
  } catch (err) {
    flashFoot("❌ 关闭失败: " + (err && err.message ? err.message : err));
  } finally {
    delete closingPids[pid];
    sessionTabsSig = '';
    renderSessionTabs();
  }
};

// ---- Chat Panel ----

// isMacOS 判定是否运行在 macOS（WKWebView）。输入锁逻辑仅 macOS 需要：
// Windows 的 AttachConsole 按 PID 注入，所有检测到的 claude 实例都可注入，不应锁定；
// 仅 macOS 的外部 Terminal.app 实例无法注入，才需区分内置/外部。
function isMacOS() {
  var p = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
  return /mac/i.test(p);
}

// isEmbeddedPid 判断 pid 是否可注入的内置终端实例。
// - 非 macOS（Windows）：一律可注入，返回 true（避免误锁可注入实例）。
// - macOS：仅 PTYRegistry 内置实例可注入；embeddedPids 尚未加载（null）时乐观返回 true，避免首屏误锁。
function isEmbeddedPid(pid) {
  if (!isMacOS()) return true;
  if (embeddedPids === null) return true; // ListTerminals 首次返回前不锁
  return pid != null && embeddedPids.has(pid);
}

// guardExternalSend 统一守卫：当前面板（或指定 pid）指向不可注入的外部实例时拦截并提示。
// 所有发送/交互入口复用，保证防御一致（输入框已锁，按钮也不应绕过）。
function guardExternalSend(optPid) {
  var pid = (optPid != null) ? optPid : chatPanelPid;
  if (!pid || isEmbeddedPid(pid)) return false;
  flashFoot("🔒 这是外部终端实例，macOS 无法直接发送，请点「窗口」切到终端输入");
  return true;
}

// updateChatInputLockState 根据当前 chatPanelPid 是否内置终端，锁定/解锁输入区
// 并显隐外部实例提示横幅。macOS 外部终端实例无法注入：输入区置灰 + 引导切到终端窗口。
function updateChatInputLockState() {
  var notice = document.getElementById("chat-external-notice");
  var area = document.querySelector(".chat-input-area");
  if (!notice || !area) return;
  var external = chatPanelPid !== null && !isEmbeddedPid(chatPanelPid);
  notice.classList.toggle("hidden", !external);
  area.classList.toggle("is-locked", external);
}

window.openChatPanel = async function(pid) {
  chatPanelPid = pid;
  chatHistoryHash = 0;
  lastChatMessages = [];
  chatHistoryIdx = -1; // 打开新会话重置导航索引，从头开始
  lastReplySignature = '';
  currentLiveAsk = null;
  syncChatChangePanelVisibilityFromPrefs(pid);
  highlightedChangeId = '';
  lastChatRenderModel = { items: [], changes: [] };
  markdownDownloads = {};
  procReset();
  loadSlashSuggestions(pid); // 预载斜杠命令/技能供消息框补全
  updateChatInputLockState(); // 外部终端实例：置灰输入区 + 显示引导横幅
  // 注意:不重置 ask 多问追踪状态——用户可能关闭面板后重开,中途的多问进度
  // (askQuestionIndex)应保留;重置交给 injectInteractivePrompts 在 tool_use ID 变化时做。

  // 标题显示当前会话主题（或回退到 PID）
  var meta = instanceMeta[pid];
  var topic = (meta && meta.topic) ? meta.topic : ('<新会话>');
  document.getElementById("chat-title").textContent = topic;
  var modelEl = document.getElementById("chat-model");
  if (meta && meta.model) {
    modelEl.textContent = meta.model;
    modelEl.style.display = "";
  } else {
    modelEl.style.display = "none";
  }
  var branchEl = document.getElementById("chat-branch");
  if (branchEl) {
    var br = (meta && meta.branch) ? meta.branch : "";
    branchEl.textContent = br ? ("🌿 " + br) : "";
    branchEl.style.display = br ? "" : "none";
  }
  var cwdEl = document.getElementById("chat-cwd");
  if (cwdEl) {
    var cwd = (meta && meta.cwd) ? meta.cwd : "";
    cwdEl.textContent = cwdTitle(cwd);
    cwdEl.title = cwd;
    cwdEl.style.display = cwd ? "" : "none";
  }

  document.getElementById("chat-messages").innerHTML = '<div class="chat-empty">加载中...</div>';
  var draftKey = chatSessionKey(pid);
  document.getElementById("chat-input").value = chatDrafts[draftKey] || "";
  if (viewMode === 'chat') {
    // 内联模式：dialog 已在 #chat-pane（永不单独 hidden），隐藏空态覆盖层即可露出 dialog
    document.getElementById("chat-pane-empty").classList.add("hidden");
  } else {
    document.getElementById("chat-overlay").classList.remove("hidden");
  }
  // 仅可注入实例抢占焦点；外部实例输入框已置灰，避免焦点落入仍可键盘输入的锁定字段。
  if (isEmbeddedPid(chatPanelPid)) document.getElementById("chat-input").focus();
  bindChatChangeResizer();
  applyChatChangePanelWidth();

  queueChatScrollRestore(pid);
  await refreshChatMessages(pid);
  renderChatStats(pid);

  // 面板打开时启动 2 秒快速轮询（主循环 1 秒也刷新，双层保障）
  if (chatRefreshTimer) clearInterval(chatRefreshTimer);
  chatRefreshTimer = setInterval(function() {
    if (chatPanelPid !== null) refreshChatMessages(chatPanelPid);
  }, 2000);
};

// ---- 处理中/完成指示器状态机（Claude Code 风格 spinner） ----

// 把毫秒格式化为 Claude Code 风格用时：< 60s → "33s"，否则 → "2m 34s"。
function procFormatDuration(ms) {
  var s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function procClearTimers() {
  if (verbSwitchTimer) { clearTimeout(verbSwitchTimer); verbSwitchTimer = null; }
  if (optimisticTimer) { clearTimeout(optimisticTimer); optimisticTimer = null; }
}

function procRandomVerbIdx() { return Math.floor(Math.random() * SPINNER_VERBS.length); }

// startProcessing：进入处理中态，开始计时 + 随机选动词 + 定期切换。
function startProcessing(startAt) {
  procStartTime = startAt || Date.now();
  procVerbIdx = procRandomVerbIdx();
  procState = 'processing';
  procRender();
  procScheduleVerbSwitch();
}

// 处理中每 3.5s 随机换一个动词，贴近 Claude Code 动效。
function procScheduleVerbSwitch() {
  if (verbSwitchTimer) clearTimeout(verbSwitchTimer);
  verbSwitchTimer = setTimeout(function() {
    if (procState !== 'processing') return;
    var next = procRandomVerbIdx();
    if (next === procVerbIdx) next = (next + 1) % SPINNER_VERBS.length;
    procVerbIdx = next;
    procRender();
    procScheduleVerbSwitch();
  }, 3500);
}

// completeProcessing：实时完成态（刚从 busy 转入 idle）。turn 可能为 null（JSONL 滞后，
// 末条 assistant 尚未落盘），此时用当前时刻兜底；有则用对话时间戳精确还原用时与完成时刻。
function completeProcessing(turn) {
  if (verbSwitchTimer) { clearTimeout(verbSwitchTimer); verbSwitchTimer = null; }
  var endAt = (turn && turn.endTs) ? turn.endTs : Date.now();
  var startAt = (turn && turn.startTs) ? turn.startTs : (procTaskStartTime || procStartTime || endAt);
  var dur = procFormatDuration(endAt - startAt);
  procCompletionText = SPINNER_VERBS[procVerbIdx].ed + ' · ' + dur + ' · ' + tsFinishedAtLabel(endAt);
  procCompletedTurnEnd = (turn && turn.endTs) ? turn.endTs : endAt;
  procState = 'completed';
  procOptimistic = false;
  procRender();
}

// showCompletedFromTurn：静态完成态——面板（重）打开时最后一轮已完成，用对话时间戳恢复
// 「完成时刻 + 用时」。这样关闭重开、或任务结束后才打开面板，完成时间仍能显示。
function showCompletedFromTurn(turn) {
  if (!turn) return;
  procClearTimers();
  var startAt = turn.startTs || procTaskStartTime || turn.endTs;
  var dur = procFormatDuration(turn.endTs - startAt);
  procCompletionText = '✓ 已完成 · ' + dur + ' · ' + tsFinishedAtLabel(turn.endTs);
  procCompletedTurnEnd = turn.endTs;
  procState = 'completed';
  procOptimistic = false;
  procRender();
}

// lastCompletedTurn 从最近渲染的消息推导「最后一个已完成轮次」的时间区间。
// 返回 {startTs, endTs}：endTs=最后一条 assistant 消息落盘时刻，
// startTs=同轮次内最后一条真实用户提问时刻（取不到则 0）。
// 末尾无 assistant 回复（任务进行中）→ 返回 null。
function lastCompletedTurn() {
  var msgs = lastChatMessages;
  if (!msgs || msgs.length === 0) return null;
  var endIdx = -1, endTs = 0;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    if (m.role === 'assistant' && m.ts) { endIdx = i; endTs = m.ts; break; }
  }
  if (endIdx < 0) return null;
  var startTs = 0;
  for (var j = endIdx; j >= 0; j--) {
    var u = msgs[j];
    if (u.role === 'user' && !isAnnotationOnly(u.content || '') && u.ts) { startTs = u.ts; break; }
  }
  return { startTs: startTs, endTs: endTs };
}

// tsFinishedAtLabel 把 epoch 毫秒格式化为「完成于 HH:MM:SS」（ts 缺失返回空串）。
function tsFinishedAtLabel(ts) {
  if (!ts) return '';
  var d = new Date(ts);
  var h = String(d.getHours()).padStart(2, '0');
  var m = String(d.getMinutes()).padStart(2, '0');
  var s = String(d.getSeconds()).padStart(2, '0');
  return '完成于 ' + h + ':' + m + ':' + s;
}

// hasChatContent 判断消息区是否已有「真实对话内容」——至少一条 assistant 回复、
// 一次工具调用，或一条非注解的用户提问。全新空会话返回 false，
// 用于抑制空面板因 busy 状态误显示处理中动效。
function hasChatContent() {
  var msgs = lastChatMessages;
  if (!msgs || msgs.length === 0) return false;
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'assistant' || m.role === 'tool_use') return true;
    if (m.role === 'user' && !isAnnotationOnly(m.content || '')) return true;
  }
  return false;
}

// procReset：清空所有状态与定时器，隐藏指示器。
function procReset() {
  procClearTimers();
  procState = 'idle';
  procOptimistic = false;
  procHasBeenBusy = false;
  procTaskStartTime = 0;
  procCompletedTurnEnd = 0;
  procIdleSince = 0;
  procRender();
}

// showProcessingOptimistic：发送消息后立即乐观进入处理中态（status 变 busy 前的空窗）。
function showProcessingOptimistic() {
  procOptimistic = true;
  procHasBeenBusy = false;
  procTaskStartTime = 0;
  if (optimisticTimer) clearTimeout(optimisticTimer);
  optimisticTimer = setTimeout(function() { procOptimistic = false; procUpdate(); }, 30000);
  startProcessing();
}

// procRender：按当前状态刷新指示器 DOM。
function procRender() {
  var el = document.getElementById('chat-processing');
  if (!el) return;
  var wasNearBottom = isChatNearBottom();
  if (procState === 'idle') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('completed', procState === 'completed');
  var textEl = el.querySelector('.chat-processing-text');
  if (procState === 'processing') {
    if (procTaskStartTime > 0) {
      // 有后端上报的真实任务起点（lifecycle hook 的 taskStartedAt），显示真实计时
      var dur = procFormatDuration(Date.now() - procTaskStartTime);
      if (textEl) textEl.textContent = SPINNER_VERBS[procVerbIdx].ing + '… · ' + dur;
    } else {
      // 真实起点未知（应用启动初期 hook 通道未就绪、taskStartedAt=0），不假装从「现在」
      // 起计时，只显示处理中动效，等锚点到位再显示真实用时——避免「从头计时」的误导。
      if (textEl) textEl.textContent = SPINNER_VERBS[procVerbIdx].ing + '…';
    }
  } else {
    if (textEl) textEl.textContent = procCompletionText;
  }
  // 仅在用户已在底部时跟随，避免打断查看历史
  if (wasNearBottom) {
    var body = document.querySelector('.chat-body');
    if (body) body.scrollTop = body.scrollHeight;
  }
}

// procUpdate：每秒由 renderChatStats 调用，驱动 idle↔processing↔completed 状态机。
// 关键改进：
//   1) 全新空会话（无真实消息内容）即使实例 status=busy 也不显示处理中动效，
//      避免空面板因状态抖动误显示动效与计时（乐观窗口 procOptimistic 例外）。
//   2) 任务完成时间基于对话时间戳推导：面板（重）打开时若最后一轮已完成，
//      直接恢复完成态，使「关闭重开」「任务结束后才打开」也能看到完成时间。
function procUpdate() {
  var el = document.getElementById('chat-processing');
  if (!el) return;
  if (chatPanelPid === null) { procReset(); return; }
  // 有交互按钮/横幅在屏(AskUserQuestion / Plan / 权限请求,含自定义输入横幅)时,
  // 是「等用户输入」而非「处理中」——隐藏 spinner,避免与按钮同屏「Processing…」误导。
  // 用按钮可见性而非 currentLiveAsk 判定:用户作答后按钮立即隐藏,spinner 能及时回来
  // (此时 ask 文件可能尚未被 PostToolUse 清掉,若按 currentLiveAsk 判会误藏 spinner)。
  var replies = document.getElementById('chat-quick-replies');
  if (replies && !replies.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  var meta = instanceMeta[chatPanelPid];
  if (!meta) { return; } // 实例已退出，保留最后完成态文案
  if (meta.taskStartedAt > 0) {
    procTaskStartTime = meta.taskStartedAt;
  }
  var busy = meta.status === 'busy';
  var turn = lastCompletedTurn();

  if (busy) {
    // 空会话（无消息内容）不因 busy 误显示；乐观窗口（用户刚发送）允许显示
    if (!hasChatContent() && !procOptimistic) { procReset(); return; }
    procHasBeenBusy = true;
    procIdleSince = 0; // busy 回来，取消未决的 idle 滞回
    procCompletedTurnEnd = 0; // 新任务开始，作废已展示的完成轮次
    if (procState !== 'processing') startProcessing(procTaskStartTime || Date.now());
    else procRender();
    return;
  }

  // idle：统一 idle 滞回守卫。所有「判定为完成」的路径（实时完成 completeProcessing、
  // 面板打开看历史 showCompletedFromTurn）都要求 status=idle 连续稳定 IDLE_SETTLE_MS，
  // 覆盖两类假完成：①任务中途 Stop 抖动（busy→idle→busy）；②应用启动初期 Detect 未稳定
  // 时 status 暂判 idle（历史 turn 会误显示「上次任务完成」）。Detect 在窗口内收敛为 busy
  // 则清滞回显示处理中，持续 idle 才判定完成。
  if (!procIdleSince) procIdleSince = Date.now();
  if (Date.now() - procIdleSince < IDLE_SETTLE_MS) {
    // 滞回窗口内不翻转完成：processing 态保持动效（计时继续跳）；idle/completed 暂不渲染。
    if (procState === 'processing') procRender();
    return;
  }
  procIdleSince = 0;

  // idle 已稳定 → 判定完成
  if (procState === 'processing') {
    if (procHasBeenBusy) {
      // 实时完成：刚从 busy 转入 idle（turn 可能因 JSONL 滞后为 null，兜底用 Date.now）
      completeProcessing(turn);
    } else if (procOptimistic) {
      // 乐观窗口内尚未变 busy，保持处理中动效
      procRender();
    } else if (turn) {
      // 末尾已有完成的轮次 → 静态展示完成
      showCompletedFromTurn(turn);
    } else {
      procReset();
    }
    return;
  }

  // procState === 'idle' | 'completed'：面板打开/重开后的稳态判定
  if (turn) {
    if (procState !== 'completed' || procCompletedTurnEnd !== turn.endTs) {
      showCompletedFromTurn(turn); // 新完成的轮次或尚未展示 → 用时间戳恢复完成态
    } else {
      procRender(); // 同一轮次，保持已展示的完成态
    }
  } else {
    procReset();
  }
}

// renderChatStats 渲染聊天面板底部 context/tokens 信息条，复用卡片的显示函数与配色。
function renderChatStats(pid) {
  var statsEl = document.getElementById("chat-stats");
  if (!statsEl) return;
  procUpdate(); // 放在最前，确保 early-return（实例退出）时也能更新处理中指示器
  if (pid === null) { statsEl.classList.add("hidden"); return; }
  var inst = instanceMeta[pid];
  if (!inst) { statsEl.classList.add("hidden"); return; } // 实例数据未就绪/已退出
  statsEl.classList.remove("hidden");

  // context：胶囊进度条（按用量配色）+ 百分比 + 明细；百分比/明细与进度条同色
  var ctxCls = contextBarClass(inst);
  renderCtxProgress(document.getElementById("chat-ctx-bar"), inst);
  var pctEl = document.getElementById("chat-ctx-pct");
  if (pctEl) { pctEl.textContent = contextPct(inst); pctEl.className = "context-pct " + ctxCls; }
  var detailEl = document.getElementById("chat-ctx-detail");
  if (detailEl) { detailEl.textContent = contextDetail(inst); detailEl.className = "context-detail " + ctxCls; }

  // tokens：累计 token 总量及 in/out/cache 明细（无累计数据时显示 —）
  var tokensEl = document.getElementById("chat-tokens");
  if (tokensEl) {
    tokensEl.textContent = chatTokensDisplay(inst);
  }

  // 分支：每秒刷新，跟随用户在其他终端的分支切换
  var branchEl = document.getElementById("chat-branch");
  if (branchEl) {
    var br = inst.branch || "";
    branchEl.textContent = br ? ("🌿 " + br) : "";
    branchEl.style.display = br ? "" : "none";
  }

  // 模型：每秒刷新，跟随 /model 切换（openChatPanel 只在打开瞬间设一次，这里补刷新）
  var modelEl = document.getElementById("chat-model");
  if (modelEl) {
    var mdl = inst.model || "";
    modelEl.textContent = mdl;
    modelEl.style.display = mdl ? "" : "none";
  }

  // 主题：与 instanceMeta 对比，不一致时更新（新会话获得主题、/clear 后主题变更）
  var titleEl = document.getElementById("chat-title");
  if (titleEl) {
    var topic = (inst && inst.topic) ? inst.topic : ('<新会话>');
    if (titleEl.textContent !== topic) titleEl.textContent = topic;
  }

  // 目录：每秒刷新
  var cwdEl = document.getElementById("chat-cwd");
  if (cwdEl) {
    var cwd = inst.cwd || "";
    cwdEl.textContent = cwdTitle(cwd);
    cwdEl.title = cwd;
    cwdEl.style.display = cwd ? "" : "none";
  }

  // 账号用量（账号级，全局 usageState，与 pid 无关）：按后端 provider 分发
  //   glm → 配额（5h token 胶囊 + % + 重置倒计时 + 月度 tooltip）
  //   deepseek → 余额（¥total + 赠送/充值 tooltip，不显示胶囊与倒计时）
  var usageGroup = document.getElementById("chat-quota-group");
  var labelEl = document.getElementById("chat-quota-label");
  var barEl = document.getElementById("chat-quota-bar");
  var pctEl = document.getElementById("chat-quota-pct");
  var resetEl = document.getElementById("chat-quota-reset");
  var weeklyEl = document.getElementById("chat-quota-weekly");
  var weeklyPctEl = document.getElementById("chat-weekly-pct");
  var weeklyResetEl = document.getElementById("chat-weekly-reset");
  var u = usageState;
  var show = u && u.available && (u.provider === "glm" || u.provider === "deepseek");
  if (!show) {
    // 不可用/不支持时不仅要隐藏整组，还要清掉上一次 provider 留下的 DOM 状态，
    // 避免从 GLM/DeepSeek 切到其他供应商后右下角残留旧配额文案/tooltip/显示样式。
    if (usageGroup) usageGroup.classList.add("hidden");
    if (labelEl) labelEl.textContent = "";
    if (barEl) {
      barEl.style.display = "";
      barEl.innerHTML = "";
      barEl.className = "ctx-progress";
      barEl.removeAttribute("title");
    }
    if (pctEl) {
      pctEl.textContent = "";
      pctEl.className = "context-pct";
      pctEl.removeAttribute("title");
    }
    if (resetEl) {
      resetEl.textContent = "";
      resetEl.style.display = "";
      resetEl.removeAttribute("title");
    }
    if (weeklyEl) weeklyEl.style.display = "none";
    if (weeklyPctEl) {
      weeklyPctEl.textContent = "";
      weeklyPctEl.className = "context-pct";
    }
    if (weeklyResetEl) weeklyResetEl.textContent = "";
  } else if (usageGroup) {
    usageGroup.classList.remove("hidden");
    if (u.provider === "glm") {
      if (labelEl) labelEl.textContent = "5h";
      if (barEl) barEl.style.display = "";
      if (resetEl) resetEl.style.display = "";
      var t = u.tokens || {};
      var pct = t.percentage || 0;
      var cls = quotaBarClass(pct);
      renderQuotaBar(barEl, pct, cls);
      if (pctEl) { pctEl.textContent = pct + "%"; pctEl.className = "context-pct " + cls; }
      if (resetEl) resetEl.textContent = quotaCountdownText(t.nextResetTime || 0);
      // 周限额：仅「周 百分比 重置时间」，无进度条
      var w = u.weekly;
      if (w && weeklyEl) {
        var wpct = w.percentage || 0;
        var wcls = quotaBarClass(wpct);
        weeklyEl.style.display = "";
        if (weeklyPctEl) { weeklyPctEl.textContent = wpct + "%"; weeklyPctEl.className = "context-pct " + wcls; }
        if (weeklyResetEl) weeklyResetEl.textContent = quotaCountdownText(w.nextResetTime || 0);
      } else if (weeklyEl) {
        weeklyEl.style.display = "none";
      }
    } else if (u.provider === "deepseek") {
      if (labelEl) labelEl.textContent = "余额";
      if (barEl) barEl.style.display = "none";    // 余额不显示配额胶囊
      if (resetEl) resetEl.style.display = "none"; // 余额没有重置概念
      if (weeklyEl) weeklyEl.style.display = "none"; // 余额无周限额
      if (pctEl) {
        pctEl.textContent = balanceDisplay(u.balance);
        pctEl.className = "context-pct";          // 余额态去掉 mid/high 配色
        pctEl.title = balanceTooltip(u.balance);
      }
    }
  }
}

window.closeChatPanel = function(opts) {
  opts = opts || {};
  saveChatScrollPosition(chatPanelPid);
  if (viewMode === 'chat') {
    // 内联切换会话时不显示空态，避免右栏闪一下；真正关闭/实例退出时才显示空态。
    if (!opts.keepPane) document.getElementById("chat-pane-empty").classList.remove("hidden");
  } else {
    document.getElementById("chat-overlay").classList.add("hidden");
  }
  document.getElementById("chat-waiting").classList.add("hidden");
  document.getElementById("chat-quick-replies").classList.add("hidden");
  document.getElementById("chat-processing").classList.add("hidden");
  hideChatHint();
  hideSlash();
  chatPanelPid = null;
  pendingChatScrollRestore = null;
  chatHistoryHash = 0;
  lastChatMessages = [];
  chatHistoryIdx = -1; // 关面板重置导航索引，避免串到下一个会话
  lastReplySignature = '';
  currentLiveAsk = null;
  highlightedChangeId = '';
  lastChatRenderModel = { items: [], changes: [] };
  markdownDownloads = {};
  renderChangePanel([]);
  var resizer = document.getElementById('chat-change-resizer');
  if (resizer) {
    resizer.classList.add('hidden');
    resizer.classList.remove('collapsed');
  }
  procReset();
  askCustomEditor = null; // 关面板清掉内联自定义编辑器态
  // 不重置 ask 多问追踪(保留中途进度,重开面板可续上)
  if (chatRefreshTimer) { clearInterval(chatRefreshTimer); chatRefreshTimer = null; }
  updateChatInputLockState(); // 复位锁态：chatPanelPid 已置 null，移除 is-locked 与外部横幅，避免残留
};

// ---- 聊天面板回溯 ----
// 回溯选择器是 Claude Code 在终端渲染的 TUI，JSONL 里没有它的列表，
// 无法在面板精准复刻/安全驱动。这里发 Esc×2 打开选择器并把该实例终端置前，
// 面板内提示用户到终端选择回溯点。
window.handleChatRewind = async function() {
  if (!chatPanelPid) return;
  showChatHint('⏪ 已打开回溯选择器，请在终端选择回溯点…');
  try {
    await Call.ByID(ID_ACT_REWIND, chatPanelPid); // 发送 ESC×2
    await Call.ByID(ID_ACT_SHOW, chatPanelPid);   // 把该实例终端置前，立刻看到选择器
  } catch (e) {
    showChatHint('回溯失败: ' + (e && e.message ? e.message : String(e)));
  }
};

// handleChatShowWin：内置终端实例 → 打开内置终端面板并切到对应 tab；外部实例 → 置前外部窗口。
window.handleChatShowWin = async function() {
  if (!chatPanelPid) return;
  // 按工作目录匹配内置终端 tab（内置实例无外部窗口，需打开内置面板）
  var cwd = '';
  var meta = instanceMeta[chatPanelPid];
  if (meta && meta.cwd) cwd = meta.cwd;
  var sid = cwd ? findTerminalTabByWorkdir(cwd) : null;
  if (sid) {
    openTerminalPanel();
    switchTerminalTab(sid);
    showChatHint('🪟 已打开内置终端');
    return;
  }
  try {
    await Call.ByID(ID_ACT_SHOW, chatPanelPid);
    showChatHint('🪟 已将该实例窗口置前');
  } catch (e) {
    showChatHint('置前失败: ' + (e && e.message ? e.message : String(e)));
  }
};

// showChatHint 显示聊天面板左下角的提示文案，4s 后自动隐藏（叠加调用重置计时）。
function showChatHint(msg) {
  var el = document.getElementById('chat-hint');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  if (chatHintTimer) clearTimeout(chatHintTimer);
  chatHintTimer = setTimeout(function() {
    el.classList.add('hidden');
    chatHintTimer = null;
  }, 4000);
}

// hideChatHint 立即隐藏提示并清计时器（关闭面板时调用）。
function hideChatHint() {
  if (chatHintTimer) { clearTimeout(chatHintTimer); chatHintTimer = null; }
  var el = document.getElementById('chat-hint');
  if (el) el.classList.add('hidden');
}

async function refreshChatMessages(pid) {
  if (pid === null) return;
  try {
    var result = await Call.ByID(ID_GET_CHAT_HISTORY, pid);
    // 新会话没有 JSONL 文件时 result.messages 为 null，当作空数组处理，
    // 避免因 early return 导致面板一直卡在「加载中...」。
    var messages = (result && result.messages) || [];
    var hash = (result && result.hash) || 0;
    // 实时旁路:每轮刷新同步挂起的 AskUserQuestion(后端实时读 ask 文件,不进 JSONL 缓存)。
    currentLiveAsk = (result && result.pendingAsk) || null;
    if (hash === chatHistoryHash && chatHistoryHash !== 0 && messages.length > 0) {
      // 消息未变(hash 稳定),但实例状态(busy↔idle)或 AskUserQuestion 多问进度可能已变——
      // 交互按钮的显隐依赖这些信号,必须用最近渲染的消息重新评估,
      // 否则「面板已开 + 提示刚出现时短暂 busy」会永久错过按钮注入。
      injectInteractivePrompts(lastChatMessages);
      return;
    }
    chatHistoryHash = hash;
    renderChatMessages(messages);
  } catch (e) {
    console.error("Chat history error:", e);
    var msgEl = document.getElementById("chat-messages");
    msgEl.innerHTML = '<div class="chat-empty">加载失败: ' + (e && e.message ? e.message : String(e)) + '</div>';
  }
}

// isChatNearBottom 判断聊天面板是否已滚到底部附近（< 80px）。
// 用于决定自动滚动跟随最新内容——用户在查看历史时不打断。
function isChatNearBottom() {
  var body = document.querySelector(".chat-body");
  if (!body) return true;
  return body.scrollHeight - body.scrollTop - body.clientHeight < 80;
}

function renderChangePanel(changes) {
  changes = changes || [];
  var panel = document.getElementById('chat-change-panel');
  var btn = document.getElementById('chat-change-toggle-btn');
  if (!panel || !btn) return;
  if (changes.length === 0) {
    setChatChangePanelDomState(false);
    btn.classList.add('hidden');
    btn.textContent = '修改';
    return;
  }
  btn.classList.remove('hidden');
  btn.textContent = (chatChangePanelVisible ? '隐藏修改' : '显示修改') + ' · ' + changes.length;
  setChatChangePanelDomState(true);

  var byFile = {};
  var order = [];
  for (var i = 0; i < changes.length; i++) {
    var c = changes[i];
    var fp = c.filePath || '未知文件';
    if (!byFile[fp]) { byFile[fp] = []; order.push(fp); }
    byFile[fp].push(c);
  }
  var html = '<div class="chat-change-header"><span>文件修改</span><span>' + order.length + ' 文件 · ' + changes.length + ' 处</span></div>'
    + '<div class="chat-change-list">';
  for (var f = 0; f < order.length; f++) {
    var file = order[f];
    html += '<section class="chat-change-file"><div class="chat-change-file-title" title="' + escAttr(file) + '">📄 ' + escHtml(file) + '</div>';
    var list = byFile[file];
    for (var j = 0; j < list.length; j++) {
      var ch = list[j];
      html += '<article class="chat-change-entry' + (highlightedChangeId === ch.id ? ' active' : '') + '" id="' + escAttr(ch.id) + '">'
        + '<div class="chat-change-entry-head">'
        + '<span class="chat-change-tool">' + escHtml(ch.tool) + '</span>'
        + '<span class="chat-change-summary">' + escHtml(ch.summary || '') + '</span>'
        + '</div>'
        + '<div class="chat-change-preview">' + (ch.previewHTML || '') + '</div>'
        + '</article>';
    }
    html += '</section>';
  }
  html += '</div>';
  panel.innerHTML = html;
}

window.toggleChatChangePanel = function() {
  setChatChangePanelVisibility(!chatChangePanelVisible);
  renderChangePanel((lastChatRenderModel && lastChatRenderModel.changes) || []);
};

window.focusChange = function(id) {
  if (!id) return;
  highlightedChangeId = id;
  setChatChangePanelVisibility(true);
  renderChangePanel((lastChatRenderModel && lastChatRenderModel.changes) || []);
  setTimeout(function() {
    var panel = document.getElementById('chat-change-panel');
    var el = document.getElementById(id);
    if (panel && el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(function() { el.classList.remove('flash'); }, 1200);
    }
  }, 180);
};

window.downloadMarkdownMessage = async function(id) {
  var item = markdownDownloads[id];
  if (!item) return;
  try {
    var saved = await Call.ByID(ID_SAVE_TEXT_FILE, item.filename, item.content);
    if (saved) flashFoot('✓ Markdown 已保存到 ' + saved);
    else flashFoot('已取消保存 Markdown');
  } catch (e) {
    flashFoot('保存 Markdown 失败: ' + (e && e.message ? e.message : e));
  }
};

function renderChatMessages(messages) {
  lastChatMessages = messages || [];
  markdownDownloads = {};
  var container = document.getElementById("chat-messages");
  var renderModel = buildChatRenderModel(lastChatMessages);
  lastChatRenderModel = renderModel;
  var html = '';
  var items = renderModel.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    switch (item.kind) {
    case 'message':
      html += renderMessageBubble(item);
      break;
    case 'command':
      html += renderMessageBubble(item);
      break;
    case 'tool':
      html += renderToolCardWithChange(item);
      break;
    case 'tool_group':
      html += renderToolGroupCard(item);
      break;
    case 'tool_result':
      html += renderOrphanToolResult(item.message);
      break;
    }
  }
  if (lastChatMessages.length === 0) {
    html = '<div class="chat-empty">✨ 发送第一条消息，开始对话吧</div>';
  }
  // 重建前记录滚动状态：仅在用户原本就在底部附近时才跟随到底，否则保留原位置（不打断查看历史）
  var body = container.parentNode;
  var wasNearBottom = isChatNearBottom();
  var prevScrollTop = body ? body.scrollTop : 0;
  var restore = consumePendingChatScrollRestore();
  container.innerHTML = html;
  renderChangePanel(renderModel.changes || []);
  // 检测交互式提示并注入快速回复按钮
  injectInteractivePrompts(lastChatMessages);
  if (restore && body) {
    if (restore.wasNearBottom) {
      body.scrollTop = body.scrollHeight;
    } else {
      body.scrollTop = Math.max(0, Math.min(restore.scrollTop || 0, body.scrollHeight - body.clientHeight));
    }
  } else if (wasNearBottom && body) {
    body.scrollTop = body.scrollHeight;
  } else if (body) {
    body.scrollTop = prevScrollTop; // 新消息追加在末尾，保持原位置仍指向之前的内容
  }
  applyChatChangePanelWidth();
}

window.sendChatMessage = async function() {
  if (!chatPanelPid) return;
  if (guardExternalSend()) return;
  var input = document.getElementById("chat-input");
  var text = input.value.trim();
  if (!text) return;

  var btn = document.getElementById("chat-send-btn");
  btn.disabled = true;
  btn.textContent = "发送中...";

  try {
    flashFoot("发送中… PID " + chatPanelPid);
    await Call.ByID(ID_ACT_PROMPT, chatPanelPid, text);
    input.value = "";
    input.style.height = ""; // 重置 textarea 高度
    delete chatDrafts[chatDraftKey()]; // 发送成功，清除草稿
    // 记入发送历史栈（去重后移到末尾），补上 JSONL 未落盘的最新发送
    var hi = chatSendHistory.indexOf(text);
    if (hi !== -1) chatSendHistory.splice(hi, 1);
    chatSendHistory.push(text);
    if (chatSendHistory.length > 200) chatSendHistory.shift();
    chatHistoryIdx = -1; // 发送后退出历史导航态
    // 乐观显示已发送的消息
    var container = document.getElementById("chat-messages");
    var optHTML = '<div class="chat-msg chat-msg-user">'
      + '<span class="chat-msg-label">📝 用户（已发送）</span>'
      + escHtml(text)
      + '</div>';
    container.insertAdjacentHTML("beforeend", optHTML);
    var body = container.parentNode;
    body.scrollTop = body.scrollHeight;
    // 立即显示「处理中」动效（乐观），status 变 busy 后接管
    showProcessingOptimistic();
    // 立即刷新 + 2 秒后再刷新，尽快捕获 AI 回复
    refreshChatMessages(chatPanelPid);
    setTimeout(function() { if (chatPanelPid) refreshChatMessages(chatPanelPid); }, 2000);
  } catch (e) {
    flashFoot("❌ 发送失败: " + (e && e.message ? e.message : e));
  }
  btn.disabled = false;
  btn.textContent = "发送";
};

// ---- Interactive Chat: quick-reply & waiting indicator ----

function injectInteractivePrompts(messages) {
  var waitingEl = document.getElementById("chat-waiting");
  var repliesEl = document.getElementById("chat-quick-replies");
  // Type something 内联编辑器也在 quick replies 内渲染，轮询时靠签名避免重写用户正在输入的内容。
  if (!messages || messages.length === 0) {
    waitingEl.classList.add("hidden");
    repliesEl.classList.add("hidden");
    lastReplySignature = '';
    return;
  }

  // 结构化判定:Claude Code 是否有挂起的 tool_use(等待用户选择)。
  // 只认 tool 层的真实选择场景(ExitPlanMode / AskUserQuestion / 权限请求),
  // 不看 assistant 文本——Claude Code 的选择 UI 由主程序渲染,不会出现在 text 里。
  var info = detectInteraction(messages);

  // AskUserQuestion 多问追踪:同一 tool_use 可能含多个问题,Claude Code 逐个询问
  // (答完 Q1 才显示 Q2)。活跃会话 jsonl 滞后,无外部信号告知当前问到第几题,
  // 只能本地追踪 askQuestionIndex:用户在消息框点选一题后推进(见 sendQuickReply)。
  // tool_use ID 变化(新一轮提问)或交互消失则重置回第 0 题。
  if (info && info.kind === 'ask' && info.askToolUseId) {
    if (info.askToolUseId !== askToolUseId) {
      askToolUseId = info.askToolUseId;
      askQuestionIndex = 0;
      askQuestionCount = (info.askQuestions || []).length;
      askAnswers = {}; // 新一轮提问,清空旧答案记忆
      askMultiSelectPicks = {}; // 新一轮提问,清空旧多选勾选(防泄漏)
      askCustomOptions = {}; // 新一轮提问,清空旧 Type something 文本
      askCustomEditor = null;
      askTerminalFocus = {};
    }
    var qs = info.askQuestions || [];
    if (askQuestionIndex < qs.length) {
      var cur = qs[askQuestionIndex];
      // hint 附加多选标记,提示用户可勾选多项
      var multiTag = cur.multiSelect ? '（可多选）' : '';
      info.hint = '❓ ' + (cur.question || cur.header || '请选择：')
        + (qs.length > 1 ? '  （' + (askQuestionIndex + 1) + '/' + qs.length + '）' : '')
        + (multiTag ? '  ' + multiTag : '');
      info.buttons = buildAskButtons(cur);
    } else {
      // 所有问题已答完(Claude Code 进入 Submit 步骤),不在消息框显示按钮;
      // 用户在终端按 Enter 提交即可。
      info = null;
    }
  } else if (!info || info.kind !== 'ask') {
    // 非 AskUserQuestion(无交互 / plan / perm),清空多问追踪状态
    askToolUseId = '';
    askQuestionIndex = 0;
    askQuestionCount = 0;
    askAnswers = {};
    askMultiSelectPicks = {};
    askCustomOptions = {};
    askCustomEditor = null;
    askTerminalFocus = {};
  }

  // 交互暂停点判定:
  //   ExitPlanMode / AskUserQuestion → 这类工具不执行,未配对 tool_use 必然是
  //     「等待用户输入」,没有「结果尚未落盘」的 busy 态,故不依赖 busy/idle,
  //     一出现就给按钮(避免面板已开、提示刚冒出时短暂 busy 永久错过按钮)。
  //   其他工具(权限请求)→ 仍需 idle:busy 时未配对 tool_use 多半是工具执行中、
  //     result 尚未落盘,不是权限等待。
  var meta = instanceMeta[chatPanelPid];
  var isIdle = !!(meta && meta.status === 'idle');
  var alwaysInteractive = info && (info.kind === 'plan' || info.kind === 'ask');
  if (!info || (!alwaysInteractive && !isIdle)) {
    waitingEl.classList.add("hidden");
    repliesEl.classList.add("hidden");
    lastReplySignature = '';
    return;
  }

  // 显示等待状态
  waitingEl.classList.remove("hidden");

  // 高亮最后一条 assistant 消息
  var assistantEls = document.querySelectorAll(".chat-msg-assistant");
  if (assistantEls.length > 0) {
    assistantEls[assistantEls.length - 1].classList.add("chat-msg-interactive");
  }

  // 生成快速回复按钮(签名去重:每秒轮询重评估时,结构不变就不重写 innerHTML)
  // 签名只描述结构(题号 + 多选标志 + 选项列表 + 自定义项/编辑器),不含勾选态——
  // 勾选靠就地翻转 class,避免每秒轮询重写 innerHTML 冲掉用户操作。
  var askMulti = info.kind === 'ask' && info.buttons.length > 0 && info.buttons[0].multi;
  var customOpt = info.kind === 'ask' ? currentAskCustomOption() : null;
  var editorOpen = info.kind === 'ask' && askCustomEditor && askCustomEditor.key === askAnswerKey();
  var sig = info.kind;
  if (info.kind === 'ask') {
    sig += '#' + askQuestionIndex + '|m=' + (askMulti ? 1 : 0)
      + '|custom=' + (customOpt ? customOpt.text : '')
      + '|editor=' + (editorOpen ? askCustomEditor.mode : '');
  }
  sig += '|' + info.buttons.map(function(b) { return (b.optionIndex != null ? b.optionIndex : b.value); }).join(',');
  if (sig !== lastReplySignature) {
    // 选项是否带说明文字(AskUserQuestion 的 option.description),或多选/自定义项(需纵向卡片)。
    var hasDesc = false;
    for (var j = 0; j < info.buttons.length; j++) {
      if (info.buttons[j].desc) { hasDesc = true; break; }
    }
    var fullwidth = hasDesc || askMulti || editorOpen || !!customOpt; // 纵向满宽布局
    var multiQ = info.kind === 'ask' && askQuestionCount > 1; // 多问(显示 ‹ › 导航)
    // AskUserQuestion 多问时加 ‹ › 导航,且同步终端焦点(见 navAskQuestion)。
    var navPrev = '<button class="quick-reply-btn nav" onclick="navAskQuestion(-1)"'
      + (askQuestionIndex <= 0 ? ' disabled' : '') + '>‹</button>';
    var navNext = '<button class="quick-reply-btn nav" onclick="navAskQuestion(1)"'
      + (askQuestionIndex >= askQuestionCount ? ' disabled' : '') + '>›</button>';

    // 选项按钮分流:ask 多选(勾选) / ask 单选(按键序列) / plan·perm(发文本)
    var optsHTML = '';
    var currentAnswer = currentAskAnswer();
    if (fullwidth) optsHTML += '<div class="ask-option-group">';
    if (editorOpen) {
      optsHTML += renderAskCustomEditorHTML(askCustomEditor.draft || '');
    } else {
      for (var j = 0; j < info.buttons.length; j++) {
        var b = info.buttons[j];
        var cls = b.cls || '';
        if (info.kind === 'ask' && b.multi) {
          // 多选:优先用 askMultiSelectPicks（当前编辑态），无则回退到已记忆答案 askAnswers。
          var picked = isAskPicked(b.optionIndex) || !!(currentAnswer && currentAnswer.kind === 'multi' && currentAnswer.picks && currentAnswer.picks[b.optionIndex]);
          optsHTML += '<button class="quick-reply-btn with-desc ask-multi' + (picked ? ' selected' : '') + '"'
            + ' data-opt-idx="' + b.optionIndex + '" onclick="toggleAskPick(' + b.optionIndex + ')">'
            + '<span class="ask-multi-box">' + (picked ? '☑' : '☐') + '</span>'
            + '<span class="ask-option-label">' + escHtml(b.label) + '</span>'
            + (b.desc ? '<span class="ask-option-desc">' + escHtml(b.desc) + '</span>' : '')
            + '</button>';
        } else if (info.kind === 'ask') {
          // 单选:按真实已选答案高亮；不再默认高亮第一项。
          var selected = isAskSingleSelected(b.optionIndex);
          var scls = selected ? ' primary selected' : '';
          if (b.desc) {
            optsHTML += '<button class="quick-reply-btn with-desc' + scls + '" onclick="sendQuickReply(' + b.optionIndex + ', \'ask\')">'
              + '<span class="ask-option-label">' + escHtml(b.label) + '</span>'
              + '<span class="ask-option-desc">' + escHtml(b.desc) + '</span>'
              + '</button>';
          } else {
            optsHTML += '<button class="quick-reply-btn' + scls + '" onclick="sendQuickReply(' + b.optionIndex + ', \'ask\')">' + escHtml(b.label) + '</button>';
          }
        } else {
          // plan / perm:维持发文本(ActPrompt),value='1'/'2'/'3'/'y'/'n'
          if (b.desc) {
            optsHTML += '<button class="quick-reply-btn with-desc ' + cls + '" onclick="sendQuickReply(\'' + escAttr(String(b.value)) + '\', \'' + info.kind + '\')">'
              + '<span class="ask-option-label">' + escHtml(b.label) + '</span>'
              + '<span class="ask-option-desc">' + escHtml(b.desc) + '</span>'
              + '</button>';
          } else {
            optsHTML += '<button class="quick-reply-btn ' + cls + '" onclick="sendQuickReply(\'' + escAttr(String(b.value)) + '\', \'' + info.kind + '\')">' + escHtml(b.label) + '</button>';
          }
        }
      }
      // ask 追加「✍ 自定义输入」(终端 Type something 入口/已输入自定义项) + 多选「✓ 确认提交」
      if (info.kind === 'ask') {
        optsHTML += renderAskCustomOptionHTML(customOpt, askMulti, currentAnswer);
      }
      if (askMulti) {
        optsHTML += '<button class="quick-reply-btn ask-submit" onclick="submitMultiSelect()">✓ 确认提交</button>';
      }
    }
    if (fullwidth) optsHTML += '</div>';

    var btnsHTML;
    if (fullwidth && multiQ) {
      // 满宽场景:导航放头部,避免 › 单独落在末行。
      btnsHTML = navPrev + navNext + optsHTML;
    } else {
      // 横向 pill:维持夹层式 ‹ 选项 › 布局。
      btnsHTML = (multiQ ? navPrev : '') + optsHTML + (multiQ ? navNext : '');
    }
    repliesEl.innerHTML = '<span class="chat-msg-label" style="margin-right:6px">' + escHtml(info.hint) + '</span>' + btnsHTML;
    lastReplySignature = sig;
    if (editorOpen) {
      setTimeout(function() {
        var input = document.getElementById('ask-custom-inline-input');
        if (input) { input.focus(); input.select(); }
      }, 0);
    }
  }
  repliesEl.classList.remove("hidden");
}

// ---- 多选勾选状态(就地翻转,不触发轮询重渲染) ----
function askPicksKey() { return askToolUseId + '#' + askQuestionIndex; }
function askPicksState() {
  var k = askPicksKey();
  var p = askMultiSelectPicks[k];
  // 兼容旧形状 {optionIndex:true}，读到后顺手迁移为 {picks:{...}, customSelected:false}。
  if (!p || !p.picks) {
    var old = p || {};
    p = { picks: {}, customSelected: false };
    for (var key in old) if (old[key]) p.picks[key] = true;
    askMultiSelectPicks[k] = p;
  }
  return p;
}
function isAskPicked(optionIndex) {
  var p = askPicksState();
  return !!(p.picks && p.picks[optionIndex]);
}
function isAskCustomPicked(currentAnswer) {
  var p = askPicksState();
  return !!(p.customSelected || (currentAnswer && currentAnswer.kind === 'multi' && currentAnswer.customSelected));
}
// toggleAskPick 切换某选项的勾选态:更新 askMultiSelectPicks + 就地翻转按钮 DOM 的 class/复选框,
// 不动 lastReplySignature(签名不含勾选态),避免每秒轮询冲掉勾选。
window.toggleAskPick = function(optionIndex) {
  var p = askPicksState();
  if (p.picks[optionIndex]) delete p.picks[optionIndex];
  else p.picks[optionIndex] = true;
  var btn = document.querySelector('#chat-quick-replies button[data-opt-idx="' + optionIndex + '"]');
  if (btn) {
    var on = btn.classList.toggle('selected');
    var box = btn.querySelector('.ask-multi-box');
    if (box) box.textContent = on ? '☑' : '☐';
  }
};

window.toggleAskCustomPick = function() {
  if (!currentAskCustomOption()) { startAskCustom('create'); return; }
  var p = askPicksState();
  p.customSelected = !p.customSelected;
  var btn = document.querySelector('#chat-quick-replies .ask-custom-value');
  if (btn) {
    btn.classList.toggle('selected', p.customSelected);
    var box = btn.querySelector('.ask-multi-box');
    if (box) box.textContent = p.customSelected ? '☑' : '☐';
  }
};

// buildAskButtons 由一个 AskUserQuestion 问题(question)构造快速回复按钮。
// 每个按钮带 optionIndex(options 数组 0-based 原始下标),供 buildAskSequence 计算方向键次数;
// multi 标志透传给渲染层决定单选(点击即发)还是多选(点击勾选 + 单独提交)。
function buildAskButtons(question) {
  var opts = (question && question.options) || [];
  var multi = !!(question && question.multiSelect);
  var btns = [];
  for (var oi = 0; oi < opts.length; oi++) {
    var opt = opts[oi];
    var label = (typeof opt === 'object') ? (opt.label || '') : String(opt);
    // 「Type something.」是终端 UI 自动追加的自由输入项(样本确认不在 input 里,此处防御性跳过)。
    // 消息框用专门的「✍ 自定义输入」按钮承接(见 injectInteractivePrompts 渲染层)。
    if (label === 'Type something.') continue;
    var desc = (typeof opt === 'object' && opt.description) ? opt.description : '';
    btns.push({
      label: label,
      desc: desc,
      optionIndex: oi,  // options 数组原始下标(buildAskSequence 据此决定 ↓ 次数)
      multi: multi,     // 是否多选(渲染层据此决定点击行为)
      cls: ''           // 不再默认高亮第一项；高亮由 askAnswers/askMultiSelectPicks 的真实选择决定
    });
  }
  return btns;
}

function askAnswerKey() { return askToolUseId + '#' + askQuestionIndex; }
function currentAskAnswer() { return askAnswers[askAnswerKey()] || null; }
function setAskSingleAnswer(optionIndex, label) {
  askAnswers[askAnswerKey()] = { kind: 'single', optionIndex: optionIndex, label: label || '' };
}
function setAskMultiAnswer(picks, labels, customSelected, customText) {
  askAnswers[askAnswerKey()] = {
    kind: 'multi',
    picks: picks || {},
    labels: labels || [],
    customSelected: !!customSelected,
    customText: customText || ''
  };
}
function setAskCustomAnswer(text) {
  askAnswers[askAnswerKey()] = { kind: 'custom', text: text || '' };
}
function isAskSingleSelected(optionIndex) {
  var a = currentAskAnswer();
  return !!(a && a.kind === 'single' && a.optionIndex === optionIndex);
}

// currentAskQuestion 取当前 AskUserQuestion 的当前题对象(由 askQuestionIndex 决定)。
// 重新调 detectInteraction(lastChatMessages) 取最新 questions,无额外缓存状态。
function currentAskQuestion() {
  var info = detectInteraction(lastChatMessages);
  if (!info || info.kind !== 'ask') return null;
  var qs = info.askQuestions || [];
  return qs[askQuestionIndex] || qs[0] || null;
}

// getOptionLabel 取 question.options[idx] 的 label 文本。
function getOptionLabel(question, optionIndex) {
  if (!question || !question.options) return '';
  var opt = question.options[optionIndex];
  if (opt == null) return '';
  return (typeof opt === 'object') ? (opt.label || '') : String(opt);
}

// buildAskSequence 把「对当前题的选择」翻译成终端按键 token 序列。
// 返回 [{key:'down'},...] 或 [{text:'abc'},...] 的数组,JSON.stringify 后交给 ActAskAnswer。
// 终端交互(Claude Code Select 上下文,依据官方 keybindings 文档 + Issue #22300):
//   - 数字键 '1'-'9':直接选择/切换第 N 项(单选已实测可用)。
//   - j/k:select:next/previous 的官方别名,可打印字符,替代注入不了的方向键 ↓/↑。
//   - Enter(\r):确认/提交。
// 终端交互(依据最新实测):
//   - 单选:数字键 '1'-'9' 直接作答当前题。非最后一题后面不能盲补回车,否则会落到下一题默认项。
//   - 多选:数字键 toggle 各项;真正的键盘 ↑/↓ 事件有效,可用 ↓ 导航。
//   - 多选 UI 结构 = 选项列表 + Type something + Submit,需多按一次 ↓ 越过 Type something 到 Submit。
//   - Type something:用 ↓ 导航到该项,再 Enter 进入输入。
// 多问切题需同步终端 ←/→ 焦点,否则消息框与终端会错位(见 navAskQuestion)。
function buildAskSequence(p) {
  var seq = [];
  // totalOptionsCount = question.options.length + 1(+1 为终端末尾自动追加的 Type something 项)
  var totalOpts = p.totalOptionsCount || 0;
  if (p.customText) {
    // Type something:从第 1 项 ↓ 到末尾 Type something(index=选项数) + Enter 进入输入 + 文本 + Enter 提交
    // 注意:Other 文本含数字会被 claude 误判为选项选择(其已知 bug),仅字母/符号可靠。
    for (var i = 0; i < totalOpts - 1; i++) seq.push({ key: 'down' });
    seq.push({ key: 'enter' });
    seq.push({ text: p.customText });
    seq.push({ key: 'enter' });
    return seq;
  }
  if (p.multiSelect) {
    // 多选:数字键 toggle 各选中项,然后用真正的 ↓ 键导航到 Submit 项 + 回车提交。
    // UI = 选项列表 + Type something + Submit;从第 1 项到 Submit 需 ↓×totalOpts 次
    // (越过选项数-1 次到 Type something,再多 1 次到 Submit)。
    var picks = (p.selectedIndices || []).slice();
    for (var s = 0; s < picks.length; s++) seq.push({ text: String(picks[s] + 1) });
    for (var t = 0; t < totalOpts; t++) seq.push({ key: 'down' });
    seq.push({ key: 'enter' });
    return seq;
  }
  // 单选:只发数字键(optionIndex+1)直接作答当前题。
  // 非最后一题若再补回车,会误命中下一题默认高亮项;最终确认由调用方在最后一题单独处理。
  var idx = (p.selectedIndices && p.selectedIndices[0] != null) ? p.selectedIndices[0] : 0;
  seq.push({ text: String(idx + 1) });
  return seq;
}

// NO_CONFIRM_TOOLS：Claude Code 默认自动批准、无需用户权限确认的工具。
// 这些工具 tool_use 未配对 tool_result 时只是「执行中」，不应误判为权限等待。
var NO_CONFIRM_TOOLS = {
  // 只读 / 查询
  'Read': 1, 'Grep': 1, 'Glob': 1, 'LS': 1, 'LSP': 1, 'NotebookRead': 1,
  'WebSearch': 1, 'WebFetch': 1,
  // 任务管理（自动批准）
  'TodoWrite': 1, 'Task': 1, 'Agent': 1, 'Skill': 1, 'Workflow': 1,
  'TaskCreate': 1, 'TaskUpdate': 1, 'TaskGet': 1, 'TaskList': 1,
  'TaskOutput': 1, 'TaskStop': 1,
  // 定时任务（内部）
  'ScheduleWakeup': 1, 'CronCreate': 1, 'CronDelete': 1, 'CronList': 1,
  // 交互类（已有专门处理，不走 perm 分支）
  'EnterPlanMode': 1, 'ExitPlanMode': 1, 'AskUserQuestion': 1,
};

// detectInteraction 基于 messages 结构判定 Claude Code 当前的交互暂停点。
// 只识别 tool 层的真实选择场景——Claude Code 的选择 UI 由主程序在 tool 执行前渲染,
// 永远不会出现在 assistant 的 text 里,因此完全不看文本内容,杜绝「是否」「(y/n)」之类的误判。
// 返回 null 表示无挂起交互。
//
// 判定依据:最后一个 tool_use 是否「已配对到 tool_result」。
//   - 未配对(挂起) → Claude 正在等用户就这个工具做选择,按工具名分流:
//       ExitPlanMode    → Plan 审批
//       AskUserQuestion → 问题选项(取自 tool input)
//       其他工具        → 权限请求(等 yes/no)
//   - 已配对(工具执行完毕) → 返回 null
// buildAskInfoFromLive 由实时旁路的 AskRecord(currentLiveAsk)构造 detectInteraction
// 的 ask info，结构与 JSONL 分支一致——askQuestions/questions/options 复用现有
// buildAskButtons / 多问追踪 / 自定义输入全套逻辑，零特判。
function buildAskInfoFromLive(live) {
  if (!live || !live.questions || !live.questions.length) return null;
  var q0 = live.questions[0];
  var btns = buildAskButtons(q0);
  if (!btns.length) return null;
  return {
    kind: 'ask',
    hint: '❓ ' + (q0.question || q0.header || '请选择：'),
    buttons: btns,
    askToolUseId: live.toolUseId || '',
    askQuestions: live.questions
  };
}

function detectInteraction(messages) {
  // 实时旁路优先:活跃会话 JSONL 不落盘(2.1.169+),AskUserQuestion 的挂起态只能由
  // PreToolUse hook 实时捕获(currentLiveAsk)。这是「现在正等用户选择」的权威信号,
  // 优先于 JSONL 推断——JSONL 末尾 tool_use 多半是更早的已配对调用,会误判为无交互。
  if (currentLiveAsk) {
    var liveInfo = buildAskInfoFromLive(currentLiveAsk);
    if (liveInfo) return liveInfo;
  }
  // 从末尾找最后一个 tool_use
  var lastToolUseIdx = -1;
  for (var i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'tool_use') {
      lastToolUseIdx = i;
      break;
    }
  }
  if (lastToolUseIdx === -1) return null;

  var lastToolUse = messages[lastToolUseIdx];

  // 该 tool_use 是否已有对应的 tool_result(用 toolId 配对)
  if (lastToolUse.toolId) {
    for (var j = lastToolUseIdx + 1; j < messages.length; j++) {
      if (messages[j].role === 'tool_result' && messages[j].toolId === lastToolUse.toolId) {
        return null; // 已执行完毕,无挂起
      }
    }
  }

  // 挂起的 tool_use,按工具名分流到对应选择场景。
  // 标签必须与 Claude Code 真实选项语义一致(发的是数字键 1/2/3,选第 N 项):
  //   1 = Yes, and bypass permissions  → 执行且跳过后续权限确认(最激进,UI 默认光标在此)
  //   2 = Yes, manually approve edits  → 执行但逐个手动确认编辑(继续询问)
  //   3 = Tell Claude what to change   → 不执行,给反馈让 Claude 改计划
  if (lastToolUse.tool === 'ExitPlanMode') {
    return {
      kind: 'plan',
      hint: '📋 Plan 审批：',
      buttons: [
        { label: '1. 执行·跳过权限确认', value: '1', cls: 'primary' },
        { label: '2. 执行·逐个确认编辑', value: '2', cls: '' },
        { label: '3. 告诉 Claude 怎么改', value: '3', cls: '' },
      ]
    };
  }

  if (lastToolUse.tool === 'AskUserQuestion') {
    try {
      var input = JSON.parse(lastToolUse.content || '{}');
      var questions = input.questions || [];
      if (questions.length > 0) {
        // 返回全部问题 + tool_use ID;具体展示第几题由 injectInteractivePrompts
        // 按 askQuestionIndex 决定(本地多问追踪)。这里默认取第 0 题。
        var q0 = questions[0];
        var btns = buildAskButtons(q0);
        if (btns.length > 0) {
          return {
            kind: 'ask',
            hint: '❓ ' + (q0.question || q0.header || '请选择：'),
            buttons: btns,
            askToolUseId: lastToolUse.toolId,
            askQuestions: questions
          };
        }
      }
    } catch (e) { /* 解析失败则落到下方通用权限/选择处理 */ }
  }

  // 已知不需要权限确认的工具（只读/自动批准/内部交互类）→ 不显示按钮。
  // 这类工具 tool_use 未配对只是「执行中」，结果落盘前的空窗不该被误判为权限等待。
  if (NO_CONFIRM_TOOLS[lastToolUse.tool]) return null;

  // 其他 tool_use 挂起 → 工具权限请求(Claude Code 在等用户允许/拒绝)
  return {
    kind: 'perm',
    hint: '🔐 权限请求（' + (lastToolUse.tool || '工具') + '）：',
    buttons: [
      { label: '✓ 允许 (y)', value: 'y', cls: 'primary' },
      { label: '✗ 拒绝 (n)', value: 'n', cls: 'danger' },
    ]
  };
}

// navAskQuestion 切换 AskUserQuestion 多问的当前题,并同步终端 ←/→ 焦点。
// 实测若只在前端切题、不同步终端,会出现:消息框看的是第 2 题,终端仍停第 1 题,
// 结果点击第 2 题选项时,第 1 题和第 2 题同时被误答。故这里恢复同步方向键。
window.navAskQuestion = function(delta) {
  if (!askToolUseId) return;
  if (guardExternalSend()) return;
  var next = askQuestionIndex + delta;
  if (next < 0) next = 0;
  if (next > askQuestionCount) next = askQuestionCount;
  if (next === askQuestionIndex) return;
  // 自定义输入态下切题:先取消编辑器,避免输入框指向错误题号
  if (askCustomEditor) cancelAskCustom();
  askQuestionIndex = next;
  lastReplySignature = ''; // 强制重新注入(换题后按钮变了)
  if (chatPanelPid && next < askQuestionCount) {
    var key = delta > 0 ? 'right' : 'left';
    Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: key }])).catch(function(e) {
      showChatHint('切题同步失败: ' + (e && e.message ? e.message : e));
    });
  }
  injectInteractivePrompts(lastChatMessages);
};

// sendQuickReply 发送快速回复。
// kind='ask'  → value 是 optionIndex,走按键序列(ActAskAnswer + buildAskSequence)驱动终端选择。
// kind='plan'/'perm' → value 是 '1'/'2'/'3'/'y'/'n',发文本(ActPrompt)。
window.sendQuickReply = async function(value, kind) {
  if (!chatPanelPid) return;
  if (guardExternalSend()) return;
  try {
    var optimisticText = String(value);
    if (kind === 'ask') {
      // 单选:value = optionIndex。当前题只发数字键作答;若这是最后一题,等确认页渲染后直接发回车确认 Submit answers。
      var cur = currentAskQuestion();
      var isLastQuestion = askToolUseId && askQuestionIndex === askQuestionCount - 1;
      if (currentAskCustomOption()) {
        // 已在 Type something 输入过内容时,数字键会被输入框吞掉；改为先同步焦点再回车选择普通项。
        await focusAskTerminalIndex(value);
        await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: 'enter' }]));
        askTerminalFocus[askFocusKey()] = value;
      } else {
        var seq = buildAskSequence({
          questionIndex: askQuestionIndex,
          totalCount: askQuestionCount,
          totalOptionsCount: (cur ? cur.options.length : 0) + 1,
          multiSelect: false,
          selectedIndices: [value],
          customText: ''
        });
        await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify(seq));
      }
      if (isLastQuestion) {
        await new Promise(function(resolve) { setTimeout(resolve, 200); });
        await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: 'enter' }]));
      }
      optimisticText = cur ? getOptionLabel(cur, value) : String(value);
      setAskSingleAnswer(value, optimisticText);
    } else {
      // plan / perm:发文本
      await Call.ByID(ID_ACT_PROMPT, chatPanelPid, String(value));
    }
    // 推进本地多问进度(AskUserQuestion 答完一题到下一题)
    if (askToolUseId && askQuestionIndex < askQuestionCount) {
      askQuestionIndex++;
      askTerminalFocus[askFocusKey()] = 0;
    }
    showOptimisticReply(optimisticText);
    finishAskInteraction();
    refreshChatMessages(chatPanelPid);
    setTimeout(function() { if (chatPanelPid) refreshChatMessages(chatPanelPid); }, 2000);
  } catch (e) {
    flashFoot("❌ 发送失败: " + (e && e.message ? e.message : e));
  }
};

// submitMultiSelect 提交当前多选题的所有勾选:构造多选按键序列注入终端。
window.submitMultiSelect = async function() {
  if (!chatPanelPid) return;
  if (guardExternalSend()) return;
  var state = askPicksState();
  var picks = state.picks || {};
  var indices = Object.keys(picks).map(Number).sort(function(a, b) { return a - b; });
  var custom = currentAskCustomOption();
  var customSelected = !!(custom && state.customSelected);
  if (indices.length === 0 && !customSelected) { showChatHint('请至少勾选一项'); return; }
  var cur = currentAskQuestion();
  try {
    // 三阶段发送(关键):
    //  1) 先发数字键 toggle 勾选普通项/自定义项
    //  2) 等待 claude UI 消化勾选
    //  3) 根据本应用维护的终端焦点，步进到 Submit 项后回车
    // 原因:实测单发 ↓ 有效,但把多个 ↓ 批量/高速发送时 claude 多选 UI 不跟随。
    var toggleSeq = indices.map(function(i) { return { text: String(i + 1) }; });
    if (customSelected) toggleSeq.push({ text: String(askCustomIndex(cur) + 1) });
    var isLastQuestion = askToolUseId && askQuestionIndex === askQuestionCount - 1;

    if (toggleSeq.length > 0) {
      // Type something 文本刚写入后，终端仍可能处于输入态；如果直接发数字键，
      // 数字会被追加到自定义文本里（如 test235）。先用方向键离开输入态，再用数字快捷键勾选。
      if (custom) {
        await focusAskTerminalIndex(0);
        await new Promise(function(resolve) { setTimeout(resolve, 120); });
      }
      await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify(toggleSeq));
      await new Promise(function(resolve) { setTimeout(resolve, 200); });
    }

    await focusAskTerminalIndex(askSubmitIndex(cur));
    await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: 'enter' }]));

    // 最后一题会进入 AskUserQuestion 的最终确认页:
    //   1. Submit answers
    //   2. Cancel
    // 这里不能盲目对所有多选多发回车,否则在非最后一题会误伤下一题默认项。
    // 仅当当前题是最后一题时,等确认页渲染后直接发回车确认 Submit answers。
    if (isLastQuestion) {
      await new Promise(function(resolve) { setTimeout(resolve, 200); });
      await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: 'enter' }]));
    }

    var labels = indices.map(function(i) { return getOptionLabel(cur, i); });
    if (customSelected) labels.push(custom.text);
    setAskMultiAnswer(Object.assign({}, picks), labels, customSelected, customSelected ? custom.text : '');
    delete askMultiSelectPicks[askPicksKey()]; // 清该题勾选
    if (askToolUseId && askQuestionIndex < askQuestionCount) {
      askQuestionIndex++;
      askTerminalFocus[askFocusKey()] = 0;
    }
    showOptimisticReply(labels.join('、'));
    finishAskInteraction();
    refreshChatMessages(chatPanelPid);
    setTimeout(function() { if (chatPanelPid) refreshChatMessages(chatPanelPid); }, 2000);
  } catch (e) {
    flashFoot("❌ 发送失败: " + (e && e.message ? e.message : e));
  }
};

// ---- Type something 自定义输入流程 ----
// 点击「✍ 自定义输入」只是在 Claude Code 的 Type something 中创建/编辑一个自定义选项；
// 之后再次点击已创建的自定义项，才按普通选项选择/勾选。
function askOptionCount(question) {
  return (question && question.options) ? question.options.length : 0;
}
function currentAskCustomOption() {
  return askCustomOptions[askAnswerKey()] || null;
}
function askCustomIndex(question) {
  return askOptionCount(question);
}
// 输入行（Type something / 已输入的自定义项）始终位于选项之后，索引 = 选项数。
// 关键：输入自定义文本后，自定义项就占据原 Type something 那一行（仍在索引 N），
// 下方不会新增第二个 Type something；因此不要因“已存在自定义项”而 +1，否则编辑时会多走一行。
function askTypeSomethingIndex(question) {
  return askOptionCount(question);
}
function askSubmitIndex(question) {
  return askTypeSomethingIndex(question) + 1;
}
function askFocusKey() { return askAnswerKey(); }
function askFocusValue() {
  var k = askFocusKey();
  return askTerminalFocus[k] == null ? 0 : askTerminalFocus[k];
}
async function focusAskTerminalIndex(targetIndex) {
  if (!chatPanelPid) return;
  targetIndex = Math.max(0, targetIndex || 0);
  var cur = askFocusValue();
  if (cur === targetIndex) return;
  var key = targetIndex > cur ? 'down' : 'up';
  var steps = Math.abs(targetIndex - cur);
  // 多选/Ask TUI 对连续方向键很敏感，逐个发送并短暂等待比批量注入稳定。
  for (var i = 0; i < steps; i++) {
    await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: key }]));
    askTerminalFocus[askFocusKey()] = key === 'down' ? askFocusValue() + 1 : Math.max(0, askFocusValue() - 1);
    await new Promise(function(resolve) { setTimeout(resolve, 80); });
  }
}
function renderAskCustomEditorHTML(draft) {
  return '<div class="ask-custom-inline">'
    + '<span class="ask-custom-inline-label">✍ 自定义内容</span>'
    + '<input id="ask-custom-inline-input" class="ask-custom-inline-input" value="' + escAttr(draft || '') + '" placeholder="输入后点确定，只发送文本，不选择" onkeydown="onAskCustomInputKey(event)">'
    + '<button class="quick-reply-btn ask-custom-ok" onclick="confirmAskCustom()">确定</button>'
    + '<button class="quick-reply-btn ask-custom-cancel" onclick="cancelAskCustom()">取消</button>'
    + '</div>';
}
function renderAskCustomOptionHTML(customOpt, askMulti, currentAnswer) {
  if (!customOpt) {
    return '<button class="quick-reply-btn ask-custom" onclick="startAskCustom(\'create\')">✍ 自定义输入</button>';
  }
  var text = customOpt.text || '';
  if (askMulti) {
    var picked = isAskCustomPicked(currentAnswer);
    return '<div class="ask-custom-row">'
      + '<button class="quick-reply-btn with-desc ask-multi ask-custom-value' + (picked ? ' selected' : '') + '" onclick="toggleAskCustomPick()">'
      + '<span class="ask-multi-box">' + (picked ? '☑' : '☐') + '</span>'
      + '<span class="ask-option-label">✍ ' + escHtml(text) + '</span>'
      + '<span class="ask-option-desc">自定义答案，点击勾选/取消</span>'
      + '</button>'
      + '<button class="quick-reply-btn ask-custom-edit" onclick="startAskCustom(\'edit\')">编辑</button>'
      + '</div>';
  }
  var selected = currentAnswer && currentAnswer.kind === 'custom' && currentAnswer.text === text;
  return '<div class="ask-custom-row">'
    + '<button class="quick-reply-btn with-desc ask-custom ask-custom-value' + (selected ? ' selected primary' : '') + '" onclick="sendAskCustomOption()">'
    + '<span class="ask-option-label">✍ ' + escHtml(text) + '</span>'
    + '<span class="ask-option-desc">点击后才选择这个自定义答案</span>'
    + '</button>'
    + '<button class="quick-reply-btn ask-custom-edit" onclick="startAskCustom(\'edit\')">编辑</button>'
    + '</div>';
}

window.startAskCustom = async function(mode) {
  if (!chatPanelPid) return;
  var cur = currentAskQuestion();
  var k = askAnswerKey();
  var existing = currentAskCustomOption();
  mode = mode === 'edit' && existing ? 'edit' : 'create';
  askCustomEditor = { key: k, questionIndex: askQuestionIndex, mode: mode, draft: existing ? existing.text : '' };
  lastReplySignature = '';
  injectInteractivePrompts(lastChatMessages);
  try {
    // 用户确认：Claude Code 的 Type something 聚焦后就是输入状态，不额外回车。
    await focusAskTerminalIndex(askTypeSomethingIndex(cur));
  } catch (e) {
    showChatHint('移动到 Type something 失败: ' + (e && e.message ? e.message : e));
  }
};

window.cancelAskCustom = async function() {
  // 取消：不发任何自定义文本，并把终端高亮从 Type something 移回第一个选项，
  // 避免停留在输入态导致后续点击选项位置偏移。
  var editor = askCustomEditor;
  askCustomEditor = null;
  lastReplySignature = '';
  injectInteractivePrompts(lastChatMessages);
  if (chatPanelPid && editor) {
    try {
      await focusAskTerminalIndex(0);
    } catch (e) { /* 忽略：取消时的终端同步失败不阻断 UI */ }
  }
};

window.onAskCustomInputKey = function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    confirmAskCustom();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelAskCustom();
  }
};

window.confirmAskCustom = async function() {
  if (!chatPanelPid || !askCustomEditor) return;
  if (guardExternalSend()) return;
  var input = document.getElementById('ask-custom-inline-input');
  var text = input ? input.value.trim() : '';
  if (!text) { showChatHint('自定义内容不能为空'); return; }
  var flat = text.replace(/\r\n/g, ' ').replace(/\n/g, ' ');
  var editor = askCustomEditor;
  var cur = currentAskQuestion();
  try {
    await focusAskTerminalIndex(askTypeSomethingIndex(cur));
    var seq = [];
    // 发送内容前先用 Ctrl+U + Ctrl+K 清空当前输入行（删除光标到行首 + 到行尾），
    // 避免终端侧残留之前输入过的文本（编辑场景或终端记忆的上次内容）。新建/编辑统一处理。
    seq.push({ key: 'ctrl+u' });
    seq.push({ key: 'ctrl+k' });
    seq.push({ text: flat });
    // 自定义内容写入 Type something 时，单选不能回车；回车会直接触发选择/提交。
    // 多选会在输入后默认勾选新自定义项，补一个回车用于取消默认勾选，保持“确定只写入文本”。
    if (cur && cur.multiSelect) seq.push({ key: 'enter' });
    // 只把文本送进终端输入态，然后在应用里显示为可点击的自定义项。
    await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify(seq));
    askCustomOptions[editor.key] = { text: flat };
    // 统一把终端高亮移回第一个选项：写入后终端停在自定义项的输入态，
    // 若停留在此，多问的 ‹ ›（左右键）会变成自定义文本内的光标移动，无法切题；
    // 移回第一项后，后续选择/切题都从第一项位置计算。
    await focusAskTerminalIndex(0);
    askCustomEditor = null;
    lastReplySignature = '';
    showChatHint('已发送自定义文本，请点击该自定义项完成选择');
    injectInteractivePrompts(lastChatMessages);
  } catch (e) {
    showChatHint('自定义内容写入失败: ' + (e && e.message ? e.message : e));
  }
};

window.sendAskCustomOption = async function() {
  if (!chatPanelPid) return;
  if (guardExternalSend()) return;
  var cur = currentAskQuestion();
  var custom = currentAskCustomOption();
  if (!custom) { startAskCustom('create'); return; }
  try {
    var isLastQuestion = askToolUseId && askQuestionIndex === askQuestionCount - 1;
    var idx = askCustomIndex(cur);
    await focusAskTerminalIndex(idx);
    await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: 'enter' }]));
    askTerminalFocus[askFocusKey()] = idx;
    if (isLastQuestion) {
      await new Promise(function(resolve) { setTimeout(resolve, 200); });
      await Call.ByID(ID_ACT_ASK_ANSWER, chatPanelPid, JSON.stringify([{ key: 'enter' }]));
    }
    setAskCustomAnswer(custom.text);
    if (askToolUseId && askQuestionIndex < askQuestionCount) askQuestionIndex++;
    showOptimisticReply(custom.text);
    finishAskInteraction();
    refreshChatMessages(chatPanelPid);
    setTimeout(function() { if (chatPanelPid) refreshChatMessages(chatPanelPid); }, 2000);
  } catch (e) {
    flashFoot('❌ 发送失败: ' + (e && e.message ? e.message : e));
  }
};

// ---- 交互作答的公共收尾 ----
// showOptimisticReply 在消息区追加一条「快速回复」气泡并滚到底。
function showOptimisticReply(text) {
  var container = document.getElementById("chat-messages");
  container.insertAdjacentHTML("beforeend", '<div class="chat-msg chat-msg-user">'
    + '<span class="chat-msg-label">📝 快速回复</span>'
    + escHtml(text) + '</div>');
  var body = container.parentNode;
  body.scrollTop = body.scrollHeight;
}

// finishAskInteraction 隐藏交互 UI、重置签名、显示处理中动效(下一题随后刷新时重新注入)。
function finishAskInteraction() {
  document.getElementById("chat-waiting").classList.add("hidden");
  document.getElementById("chat-quick-replies").classList.add("hidden");
  lastReplySignature = '';
  showProcessingOptimistic();
}

// ---- 消息框草稿：按 pid+cwd 存储，关闭面板后保留，发送后清除 ----
function chatSessionKey(pid) {
  var targetPid = pid || chatPanelPid;
  if (!targetPid) return null;
  var meta = instanceMeta[targetPid];
  var cwd = (meta && meta.cwd) ? meta.cwd : '';
  return targetPid + '|' + cwd;
}

function chatDraftKey() {
  return chatSessionKey(chatPanelPid);
}

function saveChatScrollPosition(pid) {
  var key = chatSessionKey(pid);
  var body = document.querySelector(".chat-body");
  if (!key || !body) return;
  chatScrollPositions[key] = {
    scrollTop: body.scrollTop,
    wasNearBottom: body.scrollHeight - body.scrollTop - body.clientHeight < 80
  };
}

function queueChatScrollRestore(pid) {
  var key = chatSessionKey(pid);
  if (!key) { pendingChatScrollRestore = null; return; }
  pendingChatScrollRestore = { key: key, state: chatScrollPositions[key] || { scrollTop: 0, wasNearBottom: true } };
}

function bindChatChangeResizer() {
  var resizer = document.getElementById('chat-change-resizer');
  if (!resizer || resizer.dataset.bound === '1') return;
  resizer.dataset.bound = '1';
  resizer.addEventListener('mousedown', startChatChangeResize);
}

function consumePendingChatScrollRestore() {
  if (!pendingChatScrollRestore) return null;
  var key = chatSessionKey(chatPanelPid);
  if (!key || pendingChatScrollRestore.key !== key) return null;
  var state = pendingChatScrollRestore.state;
  pendingChatScrollRestore = null;
  return state;
}

function saveChatDraft() {
  var key = chatDraftKey();
  if (!key) return;
  var val = document.getElementById("chat-input").value;
  if (val) { chatDrafts[key] = val; }
  else { delete chatDrafts[key]; }
}

// ---- 斜杠命令/技能自动补全 ----
// 复刻 Claude Code 终端体验：消息框输入 / 后弹出可用命令/技能列表，
// 上下键选中、Enter/Tab 补全为 /name + 空格（不发送），Esc 关闭。
// 下拉为 body 级浮层，按 textarea 的 getBoundingClientRect 定位，兼容对话面板与发送对话框。

// initSlashAutocomplete 绑定两个消息框的 input 事件 + 窗口缩放重定位。
function initSlashAutocomplete() {
  var chatInput = document.getElementById("chat-input");
  if (chatInput) {
    chatInput.addEventListener("input", onSlashInput);
    chatInput.addEventListener("input", saveChatDraft);
    chatInput.addEventListener("input", onChatHistoryInput); // 手动编辑即脱离历史导航
    chatInput.addEventListener("keydown", onChatHistoryKey); // ↑/↓ 切换历史消息
    chatInput.addEventListener("blur", function() { setTimeout(hideSlash, 120); });
  }
  var promptInput = document.getElementById("prompt-input");
  if (promptInput) {
    promptInput.addEventListener("input", onSlashInput);
    promptInput.addEventListener("blur", function() { setTimeout(hideSlash, 120); });
  }
  window.addEventListener("resize", function() { if (slashOpen) positionSlashMenu(); });
}

// loadSlashSuggestions 拉取该实例可用的命令/技能并缓存（面板打开时调用）。
async function loadSlashSuggestions(pid) {
  try {
    slashList = (await Call.ByID(ID_GET_COMMANDS, pid)) || [];
  } catch (e) {
    slashList = [];
  }
}

// onSlashInput：输入框内容以 / 开头且尚无空白时，按前缀筛选并展开下拉。
function onSlashInput(e) {
  slashInput = e.target;
  var val = slashInput.value;
  if (val.length > 0 && val.charAt(0) === '/' && !/\s/.test(val)) {
    var q = val.slice(1).toLowerCase();
    slashFiltered = slashList.filter(function(c) {
      return c.name.toLowerCase().indexOf(q) === 0;
    });
    // 排序：上次使用的置顶 → 使用次数降序 → 内置优先 → 字母序（稳定可预期）
    slashFiltered.sort(function(a, b) {
      if (a.name === lastSlashName) return -1;
      if (b.name === lastSlashName) return 1;
      var ca = (slashUsage[a.name] && slashUsage[a.name].count) || 0;
      var cb = (slashUsage[b.name] && slashUsage[b.name].count) || 0;
      if (ca !== cb) return cb - ca;
      if (a.type === 'builtin' && b.type !== 'builtin') return -1;
      if (b.type === 'builtin' && a.type !== 'builtin') return 1;
      return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
    });
    if (slashFiltered.length > 0) {
      slashIdx = 0;
      showSlashMenu();
      return;
    }
  }
  hideSlash();
}

function slashTypeLabel(type) {
  return type === 'builtin' ? '内置' : (type === 'skill' ? '技能' : '命令');
}

function ensureSlashMenu() {
  var menu = document.getElementById("slash-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "slash-menu";
    menu.className = "slash-menu hidden";
    document.body.appendChild(menu);
  }
  return menu;
}

function showSlashMenu() {
  slashOpen = true;
  var menu = ensureSlashMenu();
  menu.innerHTML = slashFiltered.map(function(c, i) {
    return '<div class="slash-item' + (i === slashIdx ? ' selected' : '') + '" data-idx="' + i + '">'
      + '<span class="slash-item-name">/' + escHtml(c.name) + '</span>'
      + '<span class="slash-item-type ' + (c.type || 'command') + '">' + escHtml(slashTypeLabel(c.type)) + '</span>'
      + '<span class="slash-item-desc">' + escHtml(c.description || '') + '</span>'
      + '</div>';
  }).join('');
  var items = menu.querySelectorAll(".slash-item");
  for (var i = 0; i < items.length; i++) {
    (function(item) {
      item.addEventListener("mouseenter", function() {
        slashIdx = parseInt(item.dataset.idx, 10);
        highlightSlash();
      });
      // mousedown（先于 blur）阻止 textarea 失焦，再补全
      item.addEventListener("mousedown", function(ev) {
        ev.preventDefault();
        slashIdx = parseInt(item.dataset.idx, 10);
        acceptSlash();
      });
    })(items[i]);
  }
  positionSlashMenu();
  menu.classList.remove("hidden");
}

function positionSlashMenu() {
  if (!slashInput) return;
  var menu = document.getElementById("slash-menu");
  if (!menu) return;
  var rect = slashInput.getBoundingClientRect();
  menu.style.left = rect.left + "px";
  menu.style.width = rect.width + "px";
  menu.style.bottom = (window.innerHeight - rect.top + 4) + "px"; // 浮在输入框正上方
}

function highlightSlash() {
  var menu = document.getElementById("slash-menu");
  if (!menu) return;
  var items = menu.querySelectorAll(".slash-item");
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle("selected", i === slashIdx);
  }
  var sel = menu.querySelector(".slash-item.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

// navigateSlash 上下移动选中项（循环）。
function navigateSlash(delta) {
  if (slashFiltered.length === 0) return;
  slashIdx = (slashIdx + delta + slashFiltered.length) % slashFiltered.length;
  highlightSlash();
}

// acceptSlash 用选中命令替换输入框的 /query，补全为 /name + 空格，保留焦点。
function acceptSlash() {
  if (!slashOpen || slashIdx >= slashFiltered.length) return;
  var c = slashFiltered[slashIdx];
  if (slashInput) {
    slashInput.value = "/" + c.name + " ";
    var len = slashInput.value.length;
    slashInput.setSelectionRange(len, len);
    slashInput.focus();
  }
  // 记录使用统计（count + last），驱动下次排序：上次使用置顶、其余按次数降序
  if (!slashUsage[c.name]) slashUsage[c.name] = { count: 0, last: 0 };
  slashUsage[c.name].count++;
  slashUsage[c.name].last = Date.now();
  lastSlashName = c.name;
  try {
    localStorage.setItem('cc-slash-usage', JSON.stringify(slashUsage));
    localStorage.setItem('cc-slash-last', c.name);
  } catch (e) { /* localStorage 不可用时静默，仅本次会话生效 */ }
  // 有参数用法提示则改展示提示行（继续输入即关闭）；否则直接关闭下拉
  if (c.argHint) {
    showSlashHint(c.argHint);
  } else {
    hideSlash();
  }
}

// showSlashHint 补全选中带参数提示的命令后，下拉改显示一行用法提示；
// 复用 slash-menu 容器。提示模式放行 Enter/方向键（让发送/编辑照常），仅 Esc 关闭；
// 用户继续输入会触发 onSlashInput → hideSlash 自动关闭。
function showSlashHint(text) {
  slashOpen = true;
  slashHintActive = true;
  var menu = ensureSlashMenu();
  menu.innerHTML = '<div class="slash-hint">' + escHtml(text) + '</div>';
  positionSlashMenu();
  menu.classList.remove("hidden");
}

function hideSlash() {
  slashOpen = false;
  slashHintActive = false;
  var menu = document.getElementById("slash-menu");
  if (menu) menu.classList.add("hidden");
}

// ---- New Instance Panel ----

window.openNewInstancePanel = async function() {
  var overlay = document.getElementById("new-instance-overlay");
  var listEl = document.getElementById("recent-list");
  overlay.classList.remove("hidden");
  listEl.innerHTML = '<div class="recent-empty">加载中...</div>';

  var dirs = [];
  try { dirs = (await Call.ByID(ID_GET_RECENT_DIRS)) || []; } catch (e) { dirs = []; }

  newInstanceItems = [];
  var html = '';
  for (var i = 0; i < dirs.length; i++) {
    newInstanceItems.push({ type: 'dir', path: dirs[i] });
    html += renderRecentItem(i, '📂', dirs[i], false);
  }
  newInstanceItems.push({ type: 'pick' });
  html += renderRecentItem(newInstanceItems.length - 1, '📁', '选择其他目录...', true);

  listEl.innerHTML = html;
  // 默认选中第一项；无历史目录则选中「选择其他目录」
  newInstanceSelected = dirs.length > 0 ? 0 : (newInstanceItems.length - 1);
  newInstanceHighlight();
};

function renderRecentItem(idx, icon, label, isPick) {
  var cls = isPick ? 'recent-item recent-item-pick' : 'recent-item';
  return '<div class="' + cls + '" data-idx="' + idx + '" onclick="newInstanceActivate(' + idx + ')">'
    + '<span class="recent-item-icon">' + icon + '</span>'
    + '<span class="recent-item-path" title="' + escAttr(label) + '">' + escHtml(label) + '</span>'
    + '</div>';
}

window.closeNewInstancePanel = function() {
  document.getElementById("new-instance-overlay").classList.add("hidden");
  newInstanceSelected = -1;
  newInstanceItems = [];
};

function newInstanceHighlight() {
  var items = document.querySelectorAll('#recent-list .recent-item');
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle('active', i === newInstanceSelected);
  }
  var sel = items[newInstanceSelected];
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

window.newInstanceActivate = async function(idx) {
  var item = newInstanceItems[idx];
  if (!item) return;
  closeNewInstancePanel();
  await doLaunchInstance(item.type === 'dir' ? item.path : "");
};

async function doLaunchInstance(workdir) {
  try {
    var used = await Call.ByID(ID_LAUNCH_INSTANCE, workdir);
    if (used === "" || used == null) return; // 用户在文件夹框取消，静默
    // 内置终端：后端返回 {"embedded":true,"sessionId":"term-N"}，前端登记终端 tab（不弹面板）
    try {
      var j = JSON.parse(used);
      if (j && j.embedded && j.sessionId) {
        openTerminalTab("claude", workdir, j.sessionId);
        flashFoot("🚀 已在 " + (workdir ? workdir : "选定目录") + " 启动内置 claude（点「终端」查看）");
        setTimeout(refresh, 1500);
        return;
      }
    } catch (_) { /* 非 JSON，按外部窗口反馈处理 */ }
    flashFoot("🚀 已在 " + (workdir ? workdir : "选定目录") + " 用 " + used + " 启动 claude");
    setTimeout(refresh, 1500); // 加快新实例出现在监控列表
  } catch (e) {
    flashFoot("❌ 启动失败: " + (e && e.message ? e.message : e));
  }
}

// 新建实例面板键盘处理：面板打开时拦截 ↑↓/Enter/Esc。返回是否已处理。
function newInstanceKeyHandler(e) {
  var overlay = document.getElementById("new-instance-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return false;
  if (newInstanceItems.length === 0) return false;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    newInstanceSelected = (newInstanceSelected + 1) % newInstanceItems.length;
    newInstanceHighlight();
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    newInstanceSelected = (newInstanceSelected - 1 + newInstanceItems.length) % newInstanceItems.length;
    newInstanceHighlight();
    return true;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    newInstanceActivate(newInstanceSelected);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    closeNewInstancePanel();
    return true;
  }
  return false;
}

// ---- Prompt Modal ----
window.hidePromptModal = function() {
  document.getElementById("prompt-overlay").classList.add("hidden");
  hideSlash();
  promptTargetPid = null;
};

window.sendPrompt = async function() {
  if (!promptTargetPid) return;
  if (guardExternalSend(promptTargetPid)) return;
  var text = document.getElementById("prompt-input").value.trim();
  if (!text) return;
  try {
    flashFoot("发送中… PID " + promptTargetPid);
    await Call.ByID(ID_ACT_PROMPT, promptTargetPid, text);
    var display = text.length > 40 ? text.slice(0, 40) + "…" : text;
    flashFoot("✓  已向 PID " + promptTargetPid + " 发送：" + display);
  } catch (e) {
    flashFoot("❌ 发送失败: " + (e && e.message ? e.message : e));
  }
  hidePromptModal();
};

// ---- 内置终端（ConPTY + xterm.js）----
//
// Go 端 ConPTY 跑 claude / pwsh / cmd，输出经 Wails 事件 term:output 推送（高频），
// 键盘输入经 WriteTerminal 绑定回写。每个 tab 对应一个 xterm Terminal + 一个后端 session。
// 关 tab 立即 Kill（不留后台）。claude 子进程仍照常被监控识别。
var terms = {};           // id → { term, fit, kind, workdir, paneEl, tabEl, exited }
var termOrder = [];       // tab 顺序（id 列表）
var activeTermId = null;
var pendingOutput = {};   // id → [string]：term 注册前到达的输出（防丢帧）
var termResizeTimer = null;

// ANSI 配色：light / dark 两套，跟随系统主题。
var TERM_THEMES = {
  dark: {
    background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4",
    selectionBackground: "#264f78",
    black: "#000000", red: "#f48771", green: "#89d185", yellow: "#e2c08d",
    blue: "#75beff", magenta: "#c586c0", cyan: "#56b6c2", white: "#d4d4d4",
    brightBlack: "#808080", brightRed: "#f48771", brightGreen: "#89d185", brightYellow: "#e2c08d",
    brightBlue: "#75beff", brightMagenta: "#c586c0", brightCyan: "#56b6c2", brightWhite: "#ffffff"
  },
  light: {
    background: "#fbfbfa", foreground: "#37352f", cursor: "#37352f",
    selectionBackground: "#cfe8fd",
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#b5890d",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f5f5",
    brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#ffffff"
  }
};

function termKindIcon(kind) {
  if (kind === "claude") return "🤖";
  if (kind === "cmd") return "📑";
  return "🖥";
}
function termKindLabel(kind) {
  if (kind === "claude") return "claude";
  if (kind === "cmd") return "cmd";
  if (kind === "pwsh" || kind === "shell") return "shell";
  return kind || "term";
}
function basename(p) {
  if (!p) return "";
  var parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// 订阅后端事件（仅注册一次）。
Events.On("term:output", function(ev) {
  var d = ev && ev.data;
  if (!d || !d.id) return;
  var t = terms[d.id];
  if (t && t.term) {
    t.term.write(d.data || "");
  } else {
    // term 尚未注册（embedded 启动时输出先到）：缓存，注册时回放。
    (pendingOutput[d.id] = pendingOutput[d.id] || []).push(d.data || "");
  }
});
Events.On("term:exit", function(ev) {
  var d = ev && ev.data;
  if (!d || !d.id) return;
  var t = terms[d.id];
  if (!t) return;
  t.exited = true;
  if (t.tabEl) {
    t.tabEl.classList.add("exited");
    var lbl = t.tabEl.querySelector(".term-tab-label");
    if (lbl) lbl.textContent = termKindLabel(t.kind) + " · 已退出";
  }
  if (t.term) t.term.write("\r\n\x1b[90m[进程已退出，代码 " + (d.exitCode != null ? d.exitCode : "?") + "]\x1b[0m\r\n");
});

function isTerminalPanelVisible() {
  var o = document.getElementById("terminal-overlay");
  return !!o && !o.classList.contains("hidden");
}

window.openTerminalPanel = function() {
  var overlay = document.getElementById("terminal-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  // 不自动新建 shell：仅打开面板。若已有 tab，挂载并 fit 当前 tab 的 xterm。
  if (activeTermId && terms[activeTermId]) {
    attachXterm(activeTermId);
    setTimeout(function() {
      fitActiveTerm();
      var r = terms[activeTermId];
      if (r && r.term) { try { r.term.focus(); } catch (_) {} }
    }, 0);
  }
};

window.closeTerminalPanel = function() {
  var overlay = document.getElementById("terminal-overlay");
  if (overlay) overlay.classList.add("hidden");
};

// 新建终端 tab。presetSid 非空时复用后端已启动的 session（embedded 启动流程），否则现场 StartTerminal。
// 只登记 tab 元数据 + tab 栏条目；xterm 挂载延迟到 tab 可见时（避免在 display:none 容器里 open 导致 0 尺寸）。
// 返回 sid（成功）或 null（失败，不弹框——由调用方决定如何提示/回退）。
window.openTerminalTab = async function(kind, workdir, presetSid) {
  var sid = presetSid;
  if (!sid) {
    try {
      sid = await Call.ByID(ID_START_TERMINAL, kind, workdir);
    } catch (e) {
      return null;
    }
    if (!sid) return null;
  }

  // 登记 tab 元数据（暂不创建 xterm，等面板可见再 attachXterm）
  var rec = { term: null, fit: null, kind: kind, workdir: workdir, paneEl: null, exited: false };
  terms[sid] = rec;

  // tab 栏条目
  var tabEl = document.createElement("div");
  tabEl.className = "term-tab";
  tabEl.setAttribute("data-id", sid);
  var icon = document.createElement("span");
  icon.className = "term-tab-icon";
  icon.textContent = termKindIcon(kind);
  var lbl = document.createElement("span");
  lbl.className = "term-tab-label";
  lbl.textContent = termKindLabel(kind) + (workdir ? " · " + basename(workdir) : "");
  var close = document.createElement("span");
  close.className = "term-tab-close";
  close.textContent = "✕";
  close.title = "关闭";
  close.onclick = function(ev) { ev.stopPropagation(); closeTerminalTab(sid); };
  tabEl.appendChild(icon);
  tabEl.appendChild(lbl);
  tabEl.appendChild(close);
  tabEl.onclick = function() { switchTerminalTab(sid); };
  document.getElementById("terminal-tabs").appendChild(tabEl);
  rec.tabEl = tabEl;

  termOrder.push(sid);
  activeTermId = sid;
  // 切 tab 栏高亮（paneEl 此时可能还没创建）
  Object.keys(terms).forEach(function(tid) {
    if (terms[tid] && terms[tid].tabEl) terms[tid].tabEl.classList.toggle("active", tid === sid);
  });
  updateTerminalEmpty();

  // 面板可见才挂载 xterm；面板隐藏时（如「新建会话」内置启动）等用户开面板再挂载
  if (isTerminalPanelVisible()) {
    attachXterm(sid);
    setTimeout(function() {
      fitActiveTerm();
      var r = terms[sid];
      if (r && r.term) { try { r.term.focus(); } catch (_) {} }
    }, 0);
  }
  return sid;
};

// 「＋」新建终端：统一使用 shell kind。
// macOS/Linux → zsh/bash（经 service buildTerminalCmdlineDarwin 解析 $SHELL）；
// Windows → PowerShell（service 层 shell kind 仍映射 PowerShell）。不再回退 CMD。
window.openNewTerminal = async function() {
  var sid = await openTerminalTab("shell", "");
  if (!sid) flashFoot("启动终端失败：未找到可用 shell 终端，请检查终端配置");
};

// 挂载 xterm 到已登记的 tab（创建 paneEl、Terminal、open、绑事件、回放缓存输出）。幂等。
function attachXterm(id) {
  var rec = terms[id];
  if (!rec || rec.term) return; // 已挂载或不存在
  var body = document.getElementById("terminal-body");
  if (!body) return;

  var paneEl = document.createElement("div");
  paneEl.className = "xterm-pane";
  paneEl.setAttribute("data-id", id);
  if (id !== activeTermId) paneEl.classList.add("hidden");
  body.appendChild(paneEl);

  var term = new Terminal({
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: TERM_THEMES[document.body.classList.contains("dark") ? "dark" : "light"],
    allowProposedApi: true,
    scrollback: 5000
  });
  var fit = new FitAddon();
  term.loadAddon(fit);
  term.open(paneEl);
  rec.term = term;
  rec.fit = fit;
  rec.paneEl = paneEl;

  // 回放缓存输出（挂载前到达的输出）
  if (pendingOutput[id]) {
    pendingOutput[id].forEach(function(chunk) { term.write(chunk); });
    delete pendingOutput[id];
  }

  // 键盘输入 → 后端
  term.onData(function(data) { Call.ByID(ID_WRITE_TERMINAL, id, data); });
  // 尺寸变化 → 后端（0 尺寸跳过，避免破坏 claude TUI 布局）
  term.onResize(function(sz) {
    if (sz.cols > 0 && sz.rows > 0) Call.ByID(ID_RESIZE_TERMINAL, id, sz.cols, sz.rows);
  });
}

window.switchTerminalTab = function(id) {
  if (!terms[id]) return;
  activeTermId = id;
  // 切到可见 tab 时才挂载 xterm（若尚未）
  if (isTerminalPanelVisible()) attachXterm(id);
  Object.keys(terms).forEach(function(tid) {
    var r = terms[tid];
    var active = (tid === id);
    if (r.tabEl) r.tabEl.classList.toggle("active", active);
    if (r.paneEl) r.paneEl.classList.toggle("hidden", !active);
  });
  // 切换后 xterm 才可见，需重新 fit 才能正确测量
  setTimeout(function() {
    var r = terms[id];
    if (r && r.term) { try { r.fit.fit(); } catch (_) {} try { r.term.focus(); } catch (_) {} }
  }, 0);
};

window.closeTerminalTab = function(id) {
  var r = terms[id];
  if (!r) return;
  // 后端终止（fire-and-forget；已退出的会话后端已移除，调用无副作用）
  Call.ByID(ID_KILL_TERMINAL, id);
  if (r.term) { try { r.term.dispose(); } catch (_) {} }
  if (r.paneEl && r.paneEl.parentNode) r.paneEl.parentNode.removeChild(r.paneEl);
  if (r.tabEl && r.tabEl.parentNode) r.tabEl.parentNode.removeChild(r.tabEl);
  delete terms[id];
  delete pendingOutput[id];
  var i = termOrder.indexOf(id);
  if (i >= 0) termOrder.splice(i, 1);
  if (activeTermId === id) {
    activeTermId = termOrder.length ? termOrder[termOrder.length - 1] : null;
    if (activeTermId) switchTerminalTab(activeTermId);
  }
  updateTerminalEmpty();
};

function updateTerminalEmpty() {
  var empty = document.getElementById("terminal-empty");
  if (!empty) return;
  empty.style.display = termOrder.length ? "none" : "flex";
}

function fitActiveTerm() {
  if (!activeTermId || !terms[activeTermId] || !terms[activeTermId].fit) return;
  try { terms[activeTermId].fit.fit(); } catch (_) {}
}

// 终端面板键盘处理：面板打开时 Escape 关闭，其余按键交给 xterm 自己处理（document 监听器早退）。
function terminalKeyHandler(e) {
  var overlay = document.getElementById("terminal-overlay");
  if (!overlay || overlay.classList.contains("hidden")) return false;
  if (e.key === "Escape") {
    closeTerminalPanel();
    return true;
  }
  return true; // 面板内按键一律不触发其它全局逻辑，xterm textarea 已先行处理
}

// 按工作目录匹配内置终端 tab（用于「窗口」按钮定位内置实例）。
// 归一化比较（斜杠统一、去末尾分隔符、小写）；多个匹配取最近创建的。
function findTerminalTabByWorkdir(cwd) {
  if (!cwd) return null;
  var norm = function(p) { return ('' + p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
  var target = norm(cwd);
  for (var i = termOrder.length - 1; i >= 0; i--) {
    var tid = termOrder[i];
    if (terms[tid] && norm(terms[tid].workdir) === target) return tid;
  }
  return null;
}

// 跟随系统主题刷新所有终端配色
function applyTerminalTheme(isDark) {
  if (typeof terms === 'undefined' || !terms) return; // boot 早期调用时终端模块尚未初始化
  var theme = TERM_THEMES[isDark ? "dark" : "light"];
  Object.keys(terms).forEach(function(tid) {
    if (terms[tid] && terms[tid].term) {
      try { terms[tid].term.options.theme = theme; } catch (_) {}
    }
  });
}

// 窗口缩放 → 重新 fit 活动终端（防抖）
window.addEventListener("resize", function() {
  if (termResizeTimer) clearTimeout(termResizeTimer);
  termResizeTimer = setTimeout(fitActiveTerm, 150);
});

document.addEventListener("keydown", function(e) {
  if (newInstanceKeyHandler(e)) return;
  if (terminalKeyHandler(e)) return;

  // 斜杠命令下拉导航（对话面板 / 发送对话框均可触发）：菜单展开时拦截方向键、
  // Enter/Tab（补全而非发送）、Esc（仅关菜单）。必须在发送键判断之前处理。
  // 参数提示行模式：放行 Enter/Tab/方向键（让发送与编辑照常），仅 Esc 关闭提示
  if (slashHintActive) {
    if (e.key === "Escape") { e.preventDefault(); hideSlash(); }
    return;
  }
  if (slashOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); navigateSlash(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); navigateSlash(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptSlash(); return; }
    if (e.key === "Escape") { e.preventDefault(); hideSlash(); return; }
  }

  var promptOverlay = document.getElementById("prompt-overlay");
  var settingsOverlay = document.getElementById("settings-overlay");

  // 设置：Escape 关闭
  if (!settingsOverlay.classList.contains("hidden") && e.key === "Escape") {
    hideSettings();
    return;
  }

  // 聊天面板：可配置发送键，Ctrl/Cmd+Enter 始终发送，Escape 关闭
  // sendOnEnter=true  → 回车发送、Shift+回车换行
  // sendOnEnter=false → 回车换行、Shift+回车发送
  if (chatPanelPid !== null) {
    if (e.key === "Escape") {
      if (viewMode === 'chat') {
        // chat 布局下对话常驻右栏，Esc 不清空选中（否则会被 refresh 自动重选），改为输入框失焦
        var ci = document.getElementById("chat-input");
        if (ci) ci.blur();
      } else {
        closeChatPanel();
      }
      return;
    }
    if (e.key === "Enter" && shouldSendOnEnter(e)) {
      e.preventDefault();
      sendChatMessage();
      return;
    }
    return; // 聊天面板打开时不向下传递（其余按键交给 textarea 默认行为）
  }

  // Prompt 发送对话框：同上发送键逻辑
  if (promptOverlay.classList.contains("hidden")) return;
  if (e.key === "Escape") { hidePromptModal(); return; }
  if (e.key === "Enter" && shouldSendOnEnter(e)) {
    e.preventDefault();
    sendPrompt();
  }
});

// 判断当前 Enter 事件是否应触发「发送」。
// Ctrl/Cmd+Enter 永远发送；否则按 sendOnEnter 决定回车或 Shift+回车发送。
// Alt+Enter、纯换行、IME 组词确认(isComposing)等情况返回 false（交给默认行为）。
function shouldSendOnEnter(e) {
  if (e.isComposing) return false; // 中文输入法组词确认，不发送
  if (e.ctrlKey || e.metaKey) return true;
  if (e.altKey) return false;
  return sendOnEnter ? !e.shiftKey : e.shiftKey;
}

function updateClaudeSettingsToggleState() {
  var autoCheck = document.getElementById("toggle-auto-check-claude-settings");
  var autoRepair = document.getElementById("toggle-auto-repair-claude-settings");
  var autoRepairWrap = document.getElementById("toggle-auto-repair-claude-settings-wrap");
  var row = document.getElementById("settings-item-auto-repair-claude-settings");
  if (!autoCheck || !autoRepair || !row) return;
  var enabled = !!autoCheck.checked;
  if (!enabled) autoRepair.checked = false;
  autoRepair.disabled = !enabled;
  if (autoRepairWrap) autoRepairWrap.classList.toggle("disabled", !enabled);
  row.classList.toggle("disabled", !enabled);
}

function buildRulesHTML(rules) {
  if (!rules) return '<div class="chat-empty">加载失败</div>';
  var statusPath = escapeHtml(rules.claudeSettingsPath || '~/.claude/settings.json');
  var backupPath = escapeHtml(rules.backupPath || '~/.cc-console/orig-statusline.json');
  var statusJson = escapeHtml(rules.statusLineJson || '');
  var hooksJson = escapeHtml(rules.hooksJson || '');
  return ''
    + '<div class="rules-section">'
    + '  <div class="rules-heading">两个开关的作用</div>'
    + '  <div class="rules-text">自动检查：每 10 秒检查 ' + statusPath + ' 是否仍保留监控器要求的 statusLine 与 lifecycle hooks。\n自动修复：发现配置漂移时，自动恢复监控器需要的 statusLine 与 lifecycle hooks；关闭后只检测不写回。</div>'
    + '</div>'
    + '<div class="rules-section">'
    + '  <div class="rules-heading">本应用修改规则</div>'
    + '  <div class="rules-text">只修改 ' + statusPath + '。\n只涉及 statusLine 与 4 个 lifecycle hooks（UserPromptSubmit / PreToolUse / PostToolUse / Stop）。\n不会修改 env、model、插件配置等其他字段。\n原 statusLine 会备份到 ' + backupPath + '。</div>'
    + '</div>'
    + '<div class="rules-section">'
    + '  <div class="rules-heading">statusLine 配置片段（可复制）</div>'
    + '  <pre class="rules-code">' + statusJson + '</pre>'
    + '</div>'
    + '<div class="rules-section">'
    + '  <div class="rules-heading">hooks 配置片段（可复制）</div>'
    + '  <pre class="rules-code">' + hooksJson + '</pre>'
    + '</div>'
    + '<div class="rules-section">'
    + '  <div class="rules-heading">手动维护说明</div>'
    + '  <div class="rules-text">如果关闭自动修复，可将以上片段合并到 ' + statusPath + ' 中手动维护。\n如需恢复原状，可在监控器中禁用桥接，或移除监控器注入的 statusLine 与 hooks 条目。</div>'
    + '</div>';
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
// ---- Settings ----
window.showSettings = async function() {
  try {
    var s = await Call.ByID(ID_GET_SETTINGS);
    document.getElementById("toggle-close-quits").checked = s.closeQuits;
    document.getElementById("toggle-auto-start").checked = s.autoStart;
    document.getElementById("about-version").textContent = "版本 " + (s.version || "--");
    var modeSelect = document.getElementById("select-launch-mode");
    if (modeSelect) {
      modeSelect.value = s.launchWindowMode || "hide";
      // 当前系统不支持内置终端（ConPTY 不可用）→ 灰显 embedded 选项，回退到 hide
      var embOpt = modeSelect.querySelector('option[value="embedded"]');
      if (embOpt) {
        var avail = s.embeddedAvailable !== false;
        embOpt.disabled = !avail;
        embOpt.textContent = avail ? "应用内置终端" : "应用内置终端（当前系统不支持）";
        if (!avail && modeSelect.value === "embedded") modeSelect.value = "hide";
      }
    }
    var sendToggle = document.getElementById("toggle-enter-to-send");
    if (sendToggle) sendToggle.checked = !!s.enterToSend;
    var yoloToggle = document.getElementById("toggle-launch-yolo");
    launchYoloSetting = s.launchYolo !== false;
    if (yoloToggle) yoloToggle.checked = launchYoloSetting;
    var autoCheckToggle = document.getElementById("toggle-auto-check-claude-settings");
    if (autoCheckToggle) autoCheckToggle.checked = s.autoCheckClaudeSettings !== false;
    var autoRepairToggle = document.getElementById("toggle-auto-repair-claude-settings");
    if (autoRepairToggle) autoRepairToggle.checked = s.autoRepairClaudeSettings !== false;
    var subtitleToggle = document.getElementById("toggle-show-session-subtitle");
    if (subtitleToggle) subtitleToggle.checked = s.showSessionSubtitle !== false;
    autoCheckClaudeSettings = s.autoCheckClaudeSettings !== false;
    autoRepairClaudeSettings = s.autoRepairClaudeSettings !== false;
    updateClaudeSettingsToggleState();
  } catch (e) {
    flashFoot("加载设置失败: " + (e && e.message ? e.message : e));
  }
  document.getElementById("settings-overlay").classList.remove("hidden");
  window.switchSettingsCat("general");
};

window.hideSettings = function() {
  document.getElementById("settings-overlay").classList.add("hidden");
};

window.switchSettingsCat = function(cat) {
  var items = document.querySelectorAll(".settings-nav-item");
  for (var i = 0; i < items.length; i++) {
    items[i].classList.toggle("active", items[i].dataset.cat === cat);
  }
  document.getElementById("settings-general").classList.toggle("hidden", cat !== "general");
  document.getElementById("settings-system").classList.toggle("hidden", cat !== "system");
  document.getElementById("settings-about").classList.toggle("hidden", cat !== "about");
  if (cat === "about") refreshAboutUpdateArea(); // 已缓存新版本时直接展示
};

window.saveSetting = async function(key, val) {
  var closeQuits = document.getElementById("toggle-close-quits").checked;
  var autoStart = document.getElementById("toggle-auto-start").checked;
  var launchMode = document.getElementById("select-launch-mode").value;
  var enterToSend = document.getElementById("toggle-enter-to-send").checked;
  var launchYoloEl = document.getElementById("toggle-launch-yolo");
  var launchYolo = launchYoloEl ? launchYoloEl.checked : launchYoloSetting;
  var autoCheck = document.getElementById("toggle-auto-check-claude-settings").checked;
  var autoRepairEl = document.getElementById("toggle-auto-repair-claude-settings");
  if (key === "autoCheckClaudeSettings" && !autoCheck && autoRepairEl) autoRepairEl.checked = false;
  updateClaudeSettingsToggleState();
  var autoRepair = autoRepairEl ? autoRepairEl.checked : false;
  try {
    await Call.ByID(ID_SAVE_SETTINGS, closeQuits, autoStart, launchMode, enterToSend, launchYolo, autoCheck, autoRepair);
    launchYoloSetting = !!launchYolo;
    autoCheckClaudeSettings = !!autoCheck;
    autoRepairClaudeSettings = !!autoRepair;
    updateClaudeSettingsToggleState();
    if (key === "enterToSend") {
      sendOnEnter = !!enterToSend;
      updateSendHints();
    }
    var labels = {
      closeQuits: "关闭按钮行为",
      autoStart: "开机启动",
      launchMode: "终端窗口设置",
      enterToSend: "发送键设置",
      launchYolo: "新建实例权限设置",
      autoCheckClaudeSettings: "自动检查 Claude settings.json",
      autoRepairClaudeSettings: "自动修复 Claude settings.json"
    };
    flashFoot("✓  " + (labels[key] || "设置") + "已保存");
  } catch (e) {
    if (key === "closeQuits") document.getElementById("toggle-close-quits").checked = !val;
    else if (key === "autoStart") document.getElementById("toggle-auto-start").checked = !val;
    else if (key === "enterToSend") document.getElementById("toggle-enter-to-send").checked = !val;
    else if (key === "launchYolo" && document.getElementById("toggle-launch-yolo")) document.getElementById("toggle-launch-yolo").checked = !val;
    else if (key === "autoCheckClaudeSettings") document.getElementById("toggle-auto-check-claude-settings").checked = !val;
    else if (key === "autoRepairClaudeSettings") document.getElementById("toggle-auto-repair-claude-settings").checked = !val;
    updateClaudeSettingsToggleState();
    flashFoot("保存失败: " + (e && e.message ? e.message : e));
  }
};

window.showClaudeSettingsRules = async function() {
  var content = document.getElementById('claude-settings-rules-content');
  content.innerHTML = '<div class="chat-empty">加载中...</div>';
  document.getElementById('claude-settings-rules-overlay').classList.remove('hidden');
  try {
    var rules = await Call.ByID(ID_GET_BRIDGE_RULES);
    content.innerHTML = buildRulesHTML(rules);
  } catch (e) {
    content.innerHTML = '<div class="chat-empty">加载失败：' + escapeHtml(e && e.message ? e.message : e) + '</div>';
  }
};

window.hideClaudeSettingsRules = function() {
  document.getElementById('claude-settings-rules-overlay').classList.add('hidden');
};

window.openSettingsGithub = async function() {
  try {
    await Call.ByID(ID_OPEN_URL, "https://github.com/pie-tk/cc-console");
  } catch (e) {
    flashFoot("打开失败: " + (e && e.message ? e.message : e));
  }
};

// ---- Update ----
let pendingDownloadURL = "";

// 版本检查：应用启动时触发一次，之后每 24h 自动触发一次；
// 在「关于」页手动检查后重新计时 24h。
let lastKnownUpdate = null;        // 已知的新版本 ReleaseInfo；null 表示无新版本/尚未发现
let autoUpdateTimer = null;        // 24h 自动检查定时器句柄
const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// applyUpdateBadge 依据是否有新版本，显示/隐藏首页右上角的徽标按钮。
function applyUpdateBadge(info) {
  lastKnownUpdate = info || null;
  var btn = document.getElementById('update-badge-btn');
  if (!btn) return;
  if (info) {
    // 图标按钮：不再塞文字，版本号走 title(hover 显示)；↑ 图标与红点固定在 HTML
    btn.title = '发现新版本 v' + (info.version || '') + '，点击查看';
    btn.setAttribute('aria-label', btn.title);
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

// scheduleAutoUpdateCheck 清除旧定时器并安排 24h 后再次自动检查。
// 手动检查后也调用本函数，以「重新计时」。
function scheduleAutoUpdateCheck() {
  if (autoUpdateTimer) clearTimeout(autoUpdateTimer);
  autoUpdateTimer = setTimeout(function() {
    runUpdateCheck(false).finally(scheduleAutoUpdateCheck);
  }, AUTO_UPDATE_INTERVAL_MS);
}

// refreshAboutUpdateArea 若已缓存新版本信息，则在「关于」页直接展示，省去再次手动检查。
function refreshAboutUpdateArea() {
  if (!lastKnownUpdate) return;
  document.getElementById('update-version').textContent = 'v' + (lastKnownUpdate.version || '');
  document.getElementById('update-notes').textContent = lastKnownUpdate.body || '';
  pendingDownloadURL = lastKnownUpdate.downloadUrl || '';
  showUpdateStatus('update-available');
}

// runUpdateCheck 执行一次版本检查。
// detailed=true：同步刷新「关于」页 update-area 的检查中/结果/错误状态（手动检查用）。
// detailed=false：静默（启动/自动检查用），仅更新徽标；若用户恰在「关于」页则同步刷新。
// 返回 ReleaseInfo（有新版本）或 null；内部捕获异常，永不 reject。
async function runUpdateCheck(detailed) {
  if (detailed) showUpdateStatus('update-checking');
  try {
    var info = await Call.ByID(ID_CHECK_UPDATE);
    applyUpdateBadge(info);
    if (info) {
      // 发现新版本：若用户正在「关于」页，同步展示结果
      var aboutVisible = !document.getElementById('settings-about').classList.contains('hidden');
      if (detailed || aboutVisible) {
        document.getElementById('update-version').textContent = 'v' + (info.version || '');
        document.getElementById('update-notes').textContent = info.body || '';
        pendingDownloadURL = info.downloadUrl || '';
        showUpdateStatus('update-available');
      }
    } else if (detailed) {
      showUpdateStatus('update-uptodate');
    }
    return info;
  } catch (e) {
    applyUpdateBadge(null);
    if (detailed) {
      var errMsg = e && e.message ? e.message : '检查失败，请检查网络';
      var errEl = document.getElementById('update-error');
      if (errMsg.indexOf('限流') >= 0 || errMsg.indexOf('网络请求失败') >= 0) {
        errEl.innerHTML = '⚠ ' + errMsg + '<br><button class="about-link" style="margin-top:6px" onclick="window.openSettingsGithub()">在浏览器中查看 Releases</button>';
      } else {
        errEl.textContent = '⚠ ' + errMsg;
      }
      showUpdateStatus('update-error');
    }
    return null;
  }
}

// 启动即检查一次，随后每 24h 自动检查（手动检查会重置计时）。
function startUpdateChecks() {
  runUpdateCheck(false).finally(scheduleAutoUpdateCheck);
}

function showUpdateStatus(which) {
  // 互斥：只显示一个状态 span，移除 hidden 类并用 display 控制
  var area = document.getElementById("update-area");
  area.classList.remove("hidden");
  var states = ["update-checking", "update-available", "update-uptodate", "update-error"];
  for (var i = 0; i < states.length; i++) {
    var el = document.getElementById(states[i]);
    if (el) el.classList.toggle("hidden", states[i] !== which);
  }
}

window.checkUpdateManually = async function() {
  var btn = document.getElementById("update-check-btn");
  if (btn.disabled) return;

  var label = btn.textContent;
  btn.disabled = true;

  // 点击后置灰，结果回来时恢复；同时挂一个 15s 超时兜底强制恢复（UI 不体现）
  var restored = false;
  function restoreBtn() {
    if (restored) return;
    restored = true;
    clearTimeout(timeoutId);
    btn.textContent = label;
    btn.disabled = false;
  }
  var timeoutId = setTimeout(restoreBtn, 15000);

  await runUpdateCheck(true);
  restoreBtn();
  scheduleAutoUpdateCheck(); // 手动检查后重新计时 24h
};

window.downloadUpdate = async function() {
  if (!pendingDownloadURL) {
    flashFoot("没有可用的下载地址");
    return;
  }
  if (!(await confirmDialog("确定要下载并安装更新吗？\n\n应用将在下载完成后自动重启。", "下载并安装更新"))) return;

  var btn = document.getElementById("update-download-btn");
  var bar = document.getElementById("update-progress-bar");
  var fill = document.getElementById("update-progress-fill");
  btn.textContent = "⬇ 下载中…";
  btn.disabled = true;
  bar.classList.remove("hidden");
  fill.style.width = "0%";

  Events.Off("update:progress");
  Events.On("update:progress", function(evt) {
    var d = evt.data;
    if (d.status === "downloading") {
      var pct = d.percent || 0;
      btn.textContent = "⬇ 下载中 " + pct + "%";
      fill.style.width = pct + "%";
    } else if (d.status === "error") {
      Events.Off("update:progress");
      flashFoot("更新失败: " + (d.message || "未知错误"));
      btn.textContent = "⬇ 下载并安装更新";
      btn.disabled = false;
      bar.classList.add("hidden");
      fill.style.width = "0%";
    }
  });

  try {
    await Call.ByID(ID_DOWNLOAD_UPDATE, pendingDownloadURL);
  } catch (e) {
    Events.Off("update:progress");
    flashFoot("更新失败: " + (e && e.message ? e.message : e));
    btn.textContent = "⬇ 下载并安装更新";
    btn.disabled = false;
    bar.classList.add("hidden");
    fill.style.width = "0%";
  }
};

// 点击首页徽标：打开「关于」页并展示已缓存的新版本信息（无需再手动检查一次）。
window.openAboutUpdate = async function() {
  await showSettings();
  switchSettingsCat('about');
};

// Bind the check button
document.getElementById("update-check-btn").addEventListener("click", function() {
  window.checkUpdateManually();
});
// Bind the download button
document.getElementById("update-download-btn").addEventListener("click", function() {
  window.downloadUpdate();
});

// 会话消息中的链接 → 用系统默认浏览器打开，而非在 WebView2 内部导航/弹窗。
// .chat-body 不随消息重渲染重建，绑定一次即可覆盖所有动态渲染出的 <a>。
document.querySelector(".chat-body").addEventListener("click", function(e) {
  var a = e.target.closest("a");
  if (!a) return;
  var href = a.getAttribute("href") || "";
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    Call.ByID(ID_OPEN_URL, href).catch(function(err) {
      flashFoot("打开链接失败: " + (err && err.message ? err.message : err));
    });
  }
});

// 「回到底部」按钮：消息列表不在底部时浮现，点击平滑滚到底。
// scroll 高频触发，用 rAF 合并；复用 isChatNearBottom 的「近底」判定（< 80px 视为已到底）。
(function setupChatScrollBtn() {
  var body = document.querySelector(".chat-body");
  var btn = document.getElementById("chat-scroll-btn");
  if (!body || !btn) return;
  var ticking = false;
  function update() {
    ticking = false;
    btn.classList.toggle("visible", !isChatNearBottom());
  }
  body.addEventListener("scroll", function() {
    if (!ticking) { ticking = true; requestAnimationFrame(update); }
  }, { passive: true });
  // 自定义平滑滚动：原生 behavior:"smooth" 时长由浏览器决定且偏慢（长距离尤甚），
  // 改用 easeOutCubic 固定 ~280ms，点击后能更快归底。
  function scrollToBottom() {
    var startTop = body.scrollTop;
    var endTop = body.scrollHeight - body.clientHeight;
    var distance = endTop - startTop;
    if (distance <= 0) { body.scrollTop = endTop; return; }
    var startTime = 0;
    function step(ts) {
      if (!startTime) startTime = ts;
      var p = Math.min(1, (ts - startTime) / 280);
      body.scrollTop = startTop + distance * (1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  btn.addEventListener("click", function() {
    scrollToBottom();
    btn.classList.remove("visible");
  });
})();
