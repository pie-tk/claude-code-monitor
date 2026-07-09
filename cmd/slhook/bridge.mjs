// bridge.mjs — statusline 桥接入口(由 Claude Code 直接调用)。
//
// Claude Code 2.1.x 只执行 `node "mjs"` 形式的 statusLine(实测 exe 形式不被调用),
// 故本脚本作为 ~/.claude/settings.json 的 statusLine 入口:
//  1. 读 stdin(Claude 推送的实时会话状态 JSON)
//  2. spawn 同目录的 cc-console-sl.exe 写 live/<pid>.json(异步,不阻塞)
//  3. 链式调用用户原 statusLine(如 claude-hud),把其输出作为本脚本输出
//     ——保留用户既有状态栏,实时数据采集对 Claude 的可见输出零影响
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const monitorDir = path.join(os.homedir(), '.cc-console');

// 1. 读 stdin(带 500ms 超时,与 slhook readStdin 一致)
const stdinData = await new Promise((resolve) => {
  const chunks = [];
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } };
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 500);
});

// 2. spawn slhook 写 live(fire-and-forget,同目录)——spawn 名按平台
try {
  const slhookName = process.platform === 'win32' ? 'cc-console-sl.exe' : 'cc-console-sl';
  const slhook = path.join(path.dirname(process.argv[1]), slhookName);
  if (fs.existsSync(slhook)) {
    const sl = spawn(slhook, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    sl.stdin.on('error', () => {});
    sl.stdin.end(stdinData);
    sl.unref();
  }
} catch { /* 写 live 失败不影响状态栏 */ }

// 3. 链式调用原 statusLine,输出其结果
let origCmd = '';
try {
  origCmd = JSON.parse(fs.readFileSync(path.join(monitorDir, 'orig-statusline.json'), 'utf8')).command || '';
} catch {}

function emitEmpty() { process.stdout.write('\n'); }

if (!origCmd) { emitEmpty(); process.exit(0); }

// 把命令字符串解析为 [exe, ...args](支持双引号/单引号包裹的参数)
const tokens = (origCmd.match(/[^\s"']+|"([^"]*)"|'([^']*)'/g) || []).map((t) =>
  t.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
if (tokens.length === 0) { emitEmpty(); process.exit(0); }

try {
  const child = spawn(tokens[0], tokens.slice(1), { stdio: ['pipe', 'inherit', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {});
  child.stdin.end(stdinData);
  child.on('error', () => { emitEmpty(); process.exit(0); });
  child.on('exit', (code) => process.exit(code || 0));
} catch { emitEmpty(); process.exit(0); }
