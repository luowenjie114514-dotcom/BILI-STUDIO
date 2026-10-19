/**
 * 一次性工具: 把 public/app.js 按职责拆成 public/front/*.js。
 *
 * 拆法依据: app.js 里每个顶层 function 声明都从第 0 列开始, 结尾是第 0 列的 `}`。
 * 所以只要按行扫描, 就能判断每个函数的精确区间, 不会把函数切一半。
 *
 * 顶层 let/const(模块级状态)按出现位置归属到"它正下方那段"所在的文件。
 *
 * 用法: node tools/split-front.mjs [源文件]
 *   源文件默认 public/app.js, 也可以指定一个未被拼接过的备份。
 *   ⚠ 跑过 build.mjs 之后 public/app.js 就是拼接产物, 不能拿来再拆, 否则内容会翻倍。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SRC = path.resolve(ROOT, process.argv[2] || path.join('public', 'app.js'));
const OUT = path.join(ROOT, 'public', 'front');

/** 每个文件的函数白名单 —— 顺序就是拼接顺序 */
const GROUPS = [
  ['core.js', [
    'api', 'toast', 'esc', 'guard', 'whaleEmpty',
    'applyState', 'renderAccounts', 'checkAllAccounts', 'renderMentions', 'renderSchedules',
    'addAccount', 'testAccount', 'activateAccount', 'deleteAccount',
    'addMention', 'resolveUser', 'addMentionDirect', 'toggleMention', 'deleteMention',
    'initPresets', 'applyPreset', 'collectSettings', 'saveSettings', 'testDS',
    'analyze', 'preview', 'runNow', 'stopTask',
    'toggleSchMode', 'addSchedule', 'toggleSchedule', 'deleteSchedule',
    'pollHistory', 'historyEmptyRow', 'clearHistoryConfirm', 'loadSkins', 'applySkin', 'activateSkin', 'uploadSkin',
    'shutdownConsole', 'boot',
  ]],
  ['log.js', [
    'logLineNode', 'syncMiniEmpty', 'pollLogs',
    'toggleMiniDock', 'closeLogMini', 'openLogMini', 'gotoFullLog',
    'watchLogVisibility', 'logWinUnavailable', 'applyLogMiniVisibility',
    'clearLogs',
    'saveMiniGeom', 'restoreMiniGeom', 'initMiniDrag',
  ]],
  ['dm.js', [
    'dmPopEls', 'closeDmPop', 'applyDmFormTip', 'clampChars',
    'placeDmPop', 'toggleDmPop',
  ]],
  ['changelog.js', ['miniMarkdown', 'openChangelog', 'closeChangelog']],
  ['wins.js', [
    'initWins', 'geomOf', 'winChrome', 'setGeom', 'defaultWinLayout', 'tileAllWins',
    'scrollWinIntoView', 'applyWinState', 'loadWinState', 'saveWinState', 'syncSpacer',
    'focusWin', 'toggleWinMin', 'hideWin', 'showWin', 'toggleWinById',
    'showAllWins', 'collapseAllWins', 'recallAllWins', 'resetWinLayout',
    'updateRecallPill', 'renderWinMenu', 'toggleWinMenu', 'closeWinMenu',
    'bindWinEvents', 'startWinDrag',
  ]],
  ['theme.js', [
    'hexToRgb', 'rgbaStr', 'withAlpha', 'mixHex', 'deriveThemeColors',
    'readThemeStore', 'currentThemeColors', 'presetColors', 'storeTheme', 'persistTheme',
    'applyThemeColors', 'applyTheme', 'setThemeVar', 'saveCustomTheme', 'resetThemeColors',
    'copyThemeCss', 'renderThemeSwatches', 'toggleThemeEditor', 'syncThemeEditor',
    'normalizeHex', 'buildThemeEditor', 'paintThemeChips', 'initThemes',
    'hslToHex', 'hexToHsl', 'looseHex', 'buildColorPopBody', 'paintShades',
    'markSelectedSwatch', 'pickThemeColor', 'positionColorPop', 'closeColorPop',
    'usePresetColor', 'onColorInput', 'commitColorInput', 'openNativePicker',
    'onNativeColor', 'adjustColorBrightness', 'resetPickedColor',
  ]],
  ['term.js', [
    'termEl', 'saveTermGeom', 'restoreTermGeom', 'termLineNode', 'pollTerm',
    'showTerm', 'hideTerm', 'termRun', 'termStop', 'termClear', 'initTerm',
  ]],
];

const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);

// ---- 1. 找出每个顶层 function 的行号区间 ----
// 起始行要向上吃掉紧贴着的注释块 / 装饰分隔线:
//   // 说明            -> 属于紧跟着的那个函数
//   /* ---------- x */  -> 分隔线, 只归属下面第一个函数(后面那个不重复带)
// 这样拆分后注释不会丢。
function isCommentLike(t) {
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/');
}

const funcs = [];   // { name, start, end }
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^(?:async )?function ([A-Za-z_$][\w$]*)\s*\(/);
  if (!m) continue;
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j] === '}') { end = j; break; }
  }
  // 向上吃注释(不越过上一个函数的结尾)
  let start = i;
  const floor = funcs.length ? funcs[funcs.length - 1].end + 1 : 0;
  while (start - 1 >= floor && isCommentLike(lines[start - 1].trim())) start--;
  funcs.push({ name: m[1], start, end });
  i = end;
}

const nameToGroup = new Map();
for (const [file, names] of GROUPS) {
  for (const n of names) nameToGroup.set(n, file);
}

const missing = funcs.filter((f) => !nameToGroup.has(f.name)).map((f) => f.name);
const declared = GROUPS.flatMap(([, ns]) => ns);
const notFound = declared.filter((n) => !funcs.some((f) => f.name === n));
if (missing.length) {
  console.error('这些函数没分配文件:', missing.join(', '));
  process.exit(1);
}
if (notFound.length) {
  console.error('这些声明的函数在 app.js 里找不到:', notFound.join(', '));
  process.exit(1);
}

// ---- 2. 顶层 let/const(状态) 按"它下面第一个函数"归属 ----
// 注意: 不能只看行首, 函数体内部也可能有行首 let/const(例如函数内某行没缩进)。
// 所以先把函数内部的行号全部标出来, 只认函数区间之外的那些。
const insideFunc = new Uint8Array(lines.length);
for (const f of funcs) for (let k = f.start; k <= f.end; k++) insideFunc[k] = 1;

const STATE_RE = /^(?:const|let) /;
const stateLines = [];
for (let i = 0; i < lines.length; i++) {
  if (insideFunc[i]) continue;
  if (!STATE_RE.test(lines[i])) continue;
  // 找它后面第一个顶层函数
  const owner = funcs.find((f) => f.start > i);
  const file = owner ? nameToGroup.get(owner.name) : 'core.js';
  stateLines.push({ idx: i, file, text: lines[i] });
}

/** 跨行声明的处理: const X = [...] / {...} / (...) 要一直吃到配平的那行 */
const rawRanges = [];
for (const s of stateLines) {
  const t = lines[s.idx].trim();
  const count = (str, re) => (str.match(re) || []).length;
  // 逐行累加括号, 配平那一行就是结尾 —— 不能用「行首是 } 或 ];」这种正则,
  // 因为回调里缩进 0 的行(注释/语句)会提前匹配上, 把区间吃过头。
  let depth = count(t, /[[({]/g) - count(t, /[\]})]/g);
  let end = s.idx;
  while ((depth > 0 || !/[;]\s*$/.test(lines[end])) && end + 1 < lines.length) {
    end++;
    depth += count(lines[end], /[[({]/g) - count(lines[end], /[\]})]/g);
  }
  rawRanges.push({ start: s.idx, end, file: s.file });
}

// ---- 2b. 相邻状态合并 ----
// `let a; let b;` 连着写的时候, 前面的区间会一直延伸到下一个分号, 把后面的声明吃进去;
// 相邻(或首尾相接)的区间合并成一段, 避免同一行被输出两次。
const stateRanges = [];
for (const r of rawRanges.slice().sort((a, b) => a.start - b.start)) {
  const prev = stateRanges[stateRanges.length - 1];
  if (prev && r.start <= prev.end + 1) {
    prev.end = Math.max(prev.end, r.end);
  } else {
    stateRanges.push({ ...r });
  }
}

// ---- 2b. 顶层状态区间内的行, 一律不再当作函数/状态处理 ----
// 典型: AI_PRESETS 这种多行数组, 里面可能有缩进 0 的行, 之前的算法会误认。
const claimed = new Uint8Array(lines.length);
for (const r of stateRanges) for (let k = r.start; k <= r.end; k++) claimed[k] = 1;
for (const f of funcs) for (let k = f.start; k <= f.end; k++) claimed[k] = 1;

const leftovers = [];
for (let i = 0; i < lines.length; i++) {
  if (claimed[i]) continue;
  const t = lines[i].trim();
  if (!t) continue;
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
  if (/^['"]use strict['"];?$/.test(t)) continue;   // 归 core.js 头部
  leftovers.push(i);
}

/**
 * 剩下的是「模块级独立语句」—— 顶层 addEventListener、启动那一行等。
 * 它们没有函数名, 按顺序挂在 GROUPS 里指定文件的末尾(TAIL 表)。
 */
const TAIL = {
  'addEventListener(\'resize\'': 'dm.js',
  'addEventListener(\'scroll\'': 'dm.js',
  'document.addEventListener(\'click\'': 'dm.js',
  'document.addEventListener(\'keydown\'': 'dm.js',
  'boot().catch': 'core.js',
};

// 把连续行聚成块, 用块首行去匹配 TAIL
const tailBlocks = {};   // file -> [ [startIdx, endIdx], ... ]
const unmatched = [];
for (let k = 0; k < leftovers.length; k++) {
  const start = leftovers[k];
  let end = start;
  while (k + 1 < leftovers.length && leftovers[k + 1] === end + 1) { end = leftovers[++k]; }
  const first = lines[start].trim();
  const key = Object.keys(TAIL).find((p) => first.startsWith(p));
  if (!key) {
    // 括号没配平的代码块(回调里注释掉了一行, 会断开连续性): 向上合并到上一个块
    const prevFile = Object.keys(tailBlocks).find((f) => {
      const arr = tailBlocks[f];
      const last = arr[arr.length - 1];
      return last && last[1] < start;
    });
    if (prevFile) { tailBlocks[prevFile][tailBlocks[prevFile].length - 1][1] = end; continue; }
    unmatched.push(`${start + 1}: ${first}`);
    continue;
  }
  const file = TAIL[key];
  (tailBlocks[file] = tailBlocks[file] || []).push([start, end]);
}
if (unmatched.length) {
  console.error(`!!! 有 ${unmatched.length} 段无从归属的顶层语句, 拆分会丢内容, 中止:`);
  for (const l of unmatched.slice(0, 20)) console.error('   ', l);
  console.error('   -> 在 tools/split-front.mjs 的 TAIL 表里给它指定一个文件');
  process.exit(1);
}

// ---- 3. 头部注释与 'use strict' 归 core.js ----
// 只取文件开头那段: 空行 / 注释 / 'use strict' / "use strict";
const header = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  const isHeader = t === '' || t.startsWith('/*') || t.startsWith('*') || t.startsWith('//')
    || /^['"]use strict['"];?$/.test(t);
  if (!isHeader) break;
  header.push(lines[i]);
  if (i > 12) break;
}

// ---- 4. 组装 ----
fs.mkdirSync(OUT, { recursive: true });
const banners = {
  'core.js': '基础工具 / 状态渲染 / 各分区动作 / 启动',
  'log.js': '运行日志与右上角日志小窗',
  'dm.js': '私信形态的 ⚙ 悬浮面板',
  'changelog.js': '更新日志弹窗(markdown -> html)',
  'wins.js': '小窗工作区: 拖动 / 收起 / 关闭 / 布局',
  'theme.js': '主题色',
  'term.js': '站内终端',
};

const manifest = ['# 前端片段清单(v1.5.3 起)',
  '# build.mjs 按这个顺序把 public/front/*.js 拼成 public/app.js。',
  '# 新增片段时在这里加一行, 顺序 = 拼接顺序; 函数都是顶级声明, 共享同一个作用域。',
  '#'];

for (const [file, names] of GROUPS) {
  const body = [];
  body.push(`/* ${banners[file]} */`);
  // 该文件的状态变量
  for (const r of stateRanges.filter((x) => x.file === file)) {
    body.push(...lines.slice(r.start, r.end + 1));
  }
  if (stateRanges.some((x) => x.file === file)) body.push('');
  for (const n of names) {
    const f = funcs.find((x) => x.name === n);
    body.push(...lines.slice(f.start, f.end + 1));
    body.push('');
  }
  // 该文件的模块级独立语句(顶层 addEventListener / 启动)
  const tails = tailBlocks[file] || [];
  if (tails.length) {
    body.push(`/* ${file === 'core.js' ? '启动' : '顶层事件绑定'} */`);
    for (const [s, e] of tails) {
      body.push(...lines.slice(s, e + 1));
      body.push('');
    }
  }
  const head = file === 'core.js' ? `${header.join('\n')}\n\n` : '';
  const text = `${head}${body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  fs.writeFileSync(path.join(OUT, file), text, 'utf8');
  manifest.push(file);
  console.log(`  ${file.padEnd(14)} ${String(names.length).padStart(3)} 个函数  ${tails.length} 段顶层语句  ${text.length} 字节`);
}

fs.writeFileSync(path.join(OUT, 'manifest.txt'), `${manifest.join('\n')}\n`, 'utf8');
console.log(`\n共 ${funcs.length} 个函数, ${stateRanges.length} 段顶层状态, 已写入 public/front/`);
