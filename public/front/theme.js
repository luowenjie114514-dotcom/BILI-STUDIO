/* 主题色
 *
 * 一整套主题 = 一组 CSS 变量(全部定义在 index.html 的 :root 里, 那边有中文注释)。
 * 这里只负责: 预设 / 逐项编辑 / 自定义配色 / 存盘。
 *
 * 存哪儿: localStorage(界面先亮起来) + config.json 的 ui.theme(跟这台机器走, 换浏览器也不丢)。
 * 为什么不只存 localStorage: exe 里换个端口 / 换浏览器 localStorage 就没了, 而配色是用户调了半天的东西。
 *
 * 颜色以十六进制为主; 少数变量本身是 rgba(比如顶栏底色、主色外圈), 用 HEX_ONLY 标出来,
 * 这些不提供取色器, 换主题时按主色自动重算, 免得取色器把 rgba 拍平成不透明色。
 */
const THEME_KEY = 'bili-studio.theme';
const THEME_CUSTOM_KEY = 'bili-studio.theme.custom';

/* [名字, 主色, 副色] —— 前面三个是点色块时直接用的那张渐变缩略图 */
const THEMES = [
  ['深海青', '#3fd3c6', '#1f9fb8'],
  ['鲸蓝', '#5aa9ff', '#2f6fd0'],
  ['星紫', '#b48cff', '#7a4fe0'],
  ['落日橙', '#ffb066', '#e5762c'],
  ['樱花粉', '#ff8fc7', '#d95a9a'],
  ['苔绿', '#7fd58a', '#3f9d6a'],
  ['香槟金', '#e8d48b', '#b99b3f'],
];

/**
 * 每个可调项: [CSS 变量名(不带 --), 中文名, 分组, 是否可选色]
 * 第四项为 false 的是 rgba 变量, 不放进取色器, 由 applyThemeColors 自动推导。
 */
const THEME_VARS = [
  ['bg', '背景底色', 'bg'],
  ['bg-deep', '底部渐深', 'bg'],
  ['bg-glow1', '左上光斑', 'bg'],
  ['bg-glow2', '右上光斑', 'bg'],

  ['card', '分区底色', 'surface'],
  ['card-deep', '分区渐变深端', 'surface'],
  ['card2', '按钮底色', 'surface'],
  ['input-bg', '输入框底色', 'surface'],
  ['item-bg', '列表条目', 'surface'],
  ['item-hover', '条目悬停', 'surface'],
  ['panel', '下拉浮层', 'surface'],
  ['panel2', '小窗标题/底栏', 'surface'],
  ['panel3', '⚙ 面板底色', 'surface'],
  ['panel3-2', '⚙ 面板悬停', 'surface'],

  ['line', '边框线', 'text'],
  ['txt', '正文', 'text'],
  ['dim', '次要文字', 'text'],
  ['on-acc', '主色块上的字', 'text'],

  ['acc', '主色', 'accent'],
  ['acc2', '副色', 'accent'],

  ['log-bg', '日志面板底', 'log'],
  ['log-step', '步骤行', 'log'],
  ['log-info', '信息行', 'log'],
  ['log-time', '时间戳', 'log'],
  ['log-ok', '成功行', 'log'],
  ['log-warn', '警告行', 'log'],
  ['log-err', '错误行', 'log'],
  ['live', '活跃指示灯', 'log'],

  ['term-bg', '终端底色', 'term'],
  ['term-out', '普通输出', 'term'],
  ['term-err', '错误输出', 'term'],
  ['term-sys', '系统消息', 'term'],
  ['term-in', '我敲的命令', 'term'],
  ['term-time', '终端时间戳', 'term'],
  ['term-prompt', '提示符', 'term'],

  ['cl-bg', '弹窗底色', 'doc'],
  ['cl-panel', '弹窗标题栏', 'doc'],
  ['cl-txt', '弹窗正文', 'doc'],
  ['cl-h', '弹窗标题字', 'doc'],
  ['cl-code-bg', '代码底色', 'doc'],
  ['cl-code', '代码字色', 'doc'],
  ['cl-code-line', '代码边框', 'doc'],
  ['cl-line', '弹窗分隔线', 'doc'],
  ['cl-pill-bg', '版本标签底', 'doc'],
  ['cl-pill', '版本标签字', 'doc'],

  ['ok', '成功', 'misc'],
  ['warn', '警告', 'misc'],
  ['err', '错误', 'misc'],
  ['pink', '粉色点缀', 'misc'],
  ['danger-bg', '危险按钮底', 'misc'],
  ['danger-txt', '危险按钮字', 'misc'],
  ['dry-bg', '干跑标记底', 'misc'],
  ['ok-bg', '成功提示底', 'misc'],
  ['dry-line', '干跑标记边', 'misc'],
];

const THEME_GROUPS = [
  ['bg', 'teBg'], ['surface', 'teSurface'], ['text', 'teText'], ['accent', 'teAccent'],
  ['log', 'teLog'], ['term', 'teTerm'], ['doc', 'teDoc'], ['misc', 'teMisc'],
];

/* 只读(自动推导)的 rgba 变量 —— 不在编辑器里出现, 由 deriveThemeColors 现算 */

/* 各分组在编辑器里的排列 */

let themeState = { preset: 0, custom: null };

/* ---------- 颜色小工具 ---------- */

/** '#3fd3c6' -> [63,211,198]; 认不出来返回 null */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function rgbaStr(rgb, a) {
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

/** rgba(#3fd3c6, .22) */
function withAlpha(hex, a) {
  const rgb = hexToRgb(hex);
  return rgb ? rgbaStr(rgb, a) : '';
}

/** 在两个颜色之间插值, t=0 取 a, t=1 取 b */
function mixHex(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return a;
  const f = (i) => Math.round(x[i] + (y[i] - x[i]) * t);
  return `#${[0, 1, 2].map((i) => f(i).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * 按主色/底色算出一整套派生色: 顶栏、焦点圈、hairline 等。
 * 不手填, 免得出现「主色换了、焦点圈还是青色」这种。
 */
function deriveThemeColors(c) {
  const acc = c.acc || '#3fd3c6';
  const out = {};
  const a10 = withAlpha(acc, .12);
  const a18 = withAlpha(acc, .18);
  const a22 = withAlpha(acc, .22);
  const hdr = withAlpha(c.bg || '#071722', .72);
  const hair = withAlpha(c.txt || '#dff3ff', .07);
  if (a10) { out['acc-a10'] = a10; out['acc-a18'] = a18; out['acc-a22'] = a22; }
  if (hdr) out['header-bg'] = hdr;
  if (hair) out.hair = hair;
  return out;
}

/* ---------- 读 / 写本地存档 ---------- */

function readThemeStore() {
  let preset = 0;
  let custom = null;
  try {
    const p = parseInt(localStorage.getItem(THEME_KEY), 10);
    if (Number.isInteger(p) && p >= 0) preset = p;
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(THEME_CUSTOM_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === 'object') custom = obj;
    }
  } catch { /* ignore */ }
  return { preset, custom };
}

/** 当前应该显示的那套颜色(含派生色) */
function currentThemeColors() {
  if (themeState.preset >= THEMES.length && themeState.custom) return { ...themeState.custom };
  return presetColors(themeState.preset);
}

/** 取某个预设的完整颜色表 —— 从 :root 里读原始值, 不写死第二份 */
function presetColors(i) {
  const root = document.documentElement;
  const prevAcc = root.style.getPropertyValue('--acc');
  const prevAcc2 = root.style.getPropertyValue('--acc2');
  root.style.removeProperty('--acc');
  root.style.removeProperty('--acc2');
  const cs = getComputedStyle(root);
  const out = {};
  for (const [name] of THEME_VARS) {
    const v = cs.getPropertyValue(`--${name}`).trim();
    if (v) out[name] = v;
  }
  if (prevAcc) root.style.setProperty('--acc', prevAcc);
  if (prevAcc2) root.style.setProperty('--acc2', prevAcc2);
  const t = THEMES[i] || THEMES[0];
  out.acc = t[1];
  out.acc2 = t[2];
  return out;
}

function storeTheme() {
  try { localStorage.setItem(THEME_KEY, String(themeState.preset)); } catch { /* ignore */ }
  try {
    if (themeState.custom) localStorage.setItem(THEME_CUSTOM_KEY, JSON.stringify(themeState.custom));
  } catch { /* ignore */ }
}

/** 存到 config.json(这台机器跟着走)。失败只提示, 不打断使用 */
async function persistTheme() {
  try {
    await api('/api/ui/theme', {
      preset: themeState.preset,
      custom: themeState.custom || null,
    });
  } catch (e) {
    toast(`配色存到配置文件失败，只留在了这个浏览器里：${e.message || e}`, 'err');
  }
}

/* ---------- 应用 ---------- */

/** 把颜色表写进 :root。cols 不传就用当前状态里的那套 */
function applyThemeColors(cols) {
  const root = document.documentElement;
  // 先把主色清掉, presetColors 才能读到 :root 的原始值
  root.style.removeProperty('--acc');
  root.style.removeProperty('--acc2');
  const c = cols || currentThemeColors();
  for (const [name] of THEME_VARS) {
    if (c[name]) root.style.setProperty(`--${name}`, c[name]);
  }
  const derived = deriveThemeColors(c);
  for (const k of Object.keys(derived)) root.style.setProperty(`--${k}`, derived[k]);
  renderThemeSwatches();
  syncThemeEditor();
}

/** 选第 i 套: 0..6 是预设, 7 是自己存的那套 */
function applyTheme(i) {
  const idx = Number(i);
  if (!Number.isInteger(idx) || idx < 0) return;
  if (idx >= THEMES.length && !themeState.custom) return;
  themeState.preset = idx;
  storeTheme();
  applyThemeColors(idx < THEMES.length ? presetColors(idx) : null);
  persistTheme();
}

/** 编辑器里改了某一项 */
function setThemeVar(name, value) {
  if (!name || !value) return;
  if (!THEME_VARS.some(([n]) => n === name)) return;
  const c = currentThemeColors();
  c[name] = value;
  // 从这一刻起进入「自定义」, 原来的预设不动
  themeState.custom = c;
  themeState.preset = THEMES.length;
  storeTheme();
  applyThemeColors(c);
  dragColorName = '';
  persistTheme();
}

/** 存成自定义配色(已经是自定义状态时就是「更新」) */
function saveCustomTheme() {
  themeState.custom = currentThemeColors();
  themeState.preset = THEMES.length;
  storeTheme();
  applyThemeColors(themeState.custom);
  persistTheme();
  toast('已存成自定义配色', 'ok');
}

/** 恢复当前预设的原始配色 */
function resetThemeColors() {
  const idx = themeState.preset < THEMES.length ? themeState.preset : 0;
  themeState.preset = idx;
  themeState.custom = null;
  try { localStorage.removeItem(THEME_CUSTOM_KEY); } catch { /* ignore */ }
  storeTheme();
  applyThemeColors();
  persistTheme();
  toast(`已恢复「${THEMES[idx][0]}」的原始配色`, 'ok');
}

/** 复制成 CSS 文本 */
async function copyThemeCss() {
  const c = currentThemeColors();
  const derived = deriveThemeColors(c);
  const lines = [':root{'];
  for (const [name] of THEME_VARS) if (c[name]) lines.push(`  --${name}:${c[name]};`);
  for (const k of Object.keys(derived)) lines.push(`  --${k}:${derived[k]};`);
  lines.push('}');
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    toast('CSS 变量已复制', 'ok');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('CSS 变量已复制', 'ok'); } catch { toast('复制失败，展开的文本框里可以手动选', 'err'); }
    ta.remove();
  }
}

/* ---------- 界面 ---------- */

function renderThemeSwatches() {
  const box = document.getElementById('themeSwatches');
  if (!box) return;
  const list = THEMES.map((t, i) => ({ i, name: t[0], a: t[1], b: t[2] }));
  if (themeState.custom) {
    const c = themeState.custom;
    list.push({ i: THEMES.length, name: '自定义', a: c.acc || '#888', b: c.card || '#333' });
  }
  box.innerHTML = list.map((t) => `<div class="theme-sw${t.i === themeState.preset ? ' sel' : ''}"
    title="${esc(t.name)}" style="background:linear-gradient(135deg,${t.a},${t.b})"
    onclick="applyTheme(${t.i})"></div>`).join('');
}

function toggleThemeEditor() {
  const box = document.getElementById('themeEditor');
  if (!box) return;
  box.hidden = !box.hidden;
  const btn = document.getElementById('teToggleBtn');
  if (btn) btn.textContent = box.hidden ? '🎛 逐项配色' : '🎛 收起配色';
  if (!box.hidden) syncThemeEditor();
}

/** 编辑器里每个色块的当前值 = 当前这套颜色 */
function syncThemeEditor() {
  const box = document.getElementById('themeEditor');
  if (!box || box.hidden) return;
  const c = currentThemeColors();
  paintThemeChips(c);
  for (const [name] of THEME_VARS) {
    const el = document.getElementById(`tn_${name}`);
    if (!el) continue;
    if (dragColorName === name) continue;
    el.value = normalizeHex(c[name] || '#000000');
  }
  const out = document.getElementById('teOut');
  if (out) {
    const txt = THEME_VARS.filter(([n]) => c[n]).map(([n]) => `--${n}:${c[n]};`).join('\n');
    out.textContent = txt;
  }
}

let dragColorName = '';

/** 归一化成 #rrggbb, 认不出来给黑色 */
function normalizeHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#000000';
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 入口: 建色块、建编辑器、读存档并应用 */
function initThemes() {
  const box = document.getElementById('themeSwatches');
  if (!box) return;

  buildThemeEditor();

  const saved = readThemeStore();
  themeState = { preset: saved.preset, custom: saved.custom };
  if (themeState.preset > THEMES.length || (themeState.preset === THEMES.length && !themeState.custom)) {
    themeState.preset = 0;
    themeState.custom = null;
  }
  applyThemeColors();

  // config.json 里的 ui.theme 比 localStorage 新(换了浏览器/端口就靠它)。
  // 页面没加载完时 state 可能是 undefined, 用 typeof 挡一下。
  const remote = (typeof state !== 'undefined' && state && state.ui) ? state.ui.theme : null;
  if (remote && typeof remote === 'object' && (Number.isInteger(remote.preset) || remote.custom)) {
    const preset = Number.isInteger(remote.preset) ? remote.preset : 0;
    if (preset !== themeState.preset || JSON.stringify(remote.custom || null) !== JSON.stringify(themeState.custom || null)) {
      themeState = { preset, custom: remote.custom || null };
      if (themeState.preset > THEMES.length
          || (themeState.preset === THEMES.length && !themeState.custom)) {
        themeState = { preset: 0, custom: null };
      }
      storeTheme();
      applyThemeColors();
    }
  }
}

/**
 * 建编辑器。每个颜色项 = 一个色块(div) + 一个藏起来的原生取色器 <input type=color>。
 *
 * 为什么色块自己画: 原生控件的色样是浏览器画在 shadow DOM 里的,
 * 部分场景(旧版 Edge / 某些缩放)只画一个空框, 看起来像「坏掉了」。
 *
 * 点色块(或者点这一整行)弹出的是站内的取色面板, 不是系统那个简陋的调色板:
 * 能直接敲色码, 也能从常用色 / 同色调 / 色相里一点即用, 还能微调明暗。
 * 系统取色器留着当兜底(点面板里的「🖉 系统」)。
 *
 * 数据放 dataset.name(变量全名), DOM 用短 id, 免得 id 里带横线不好找。
 */
function buildThemeEditor() {
  const ed = document.getElementById('themeEditor');
  if (!ed || ed.dataset.ready) return;
  ed.dataset.ready = '1';
  const cols = currentThemeColors();
  for (const [group, domId] of THEME_GROUPS) {
    const host = document.getElementById(domId);
    if (!host) continue;
    host.innerHTML = THEME_VARS.filter(([, , g]) => g === group).map(([name, label]) => `
      <div class="te-row" id="tr_${name}" data-name="${name}" title="--${name}　点一下调色"
        onclick="pickThemeColor('${name}')">
        <span class="te-chip" id="te_${name}" data-name="${name}"></span>
        <input type="color" class="te-native" id="tn_${name}" value="${normalizeHex(cols[name] || '#000000')}"
          data-name="${name}" oninput="setThemeVar('${name}', this.value)">
        <span>${esc(label)}</span>
      </div>`).join('');
  }
  buildColorPopBody();
}

/* ---------- 取色面板 ---------- */

/* 常用色: 黑 / 几档灰 / 白 + 一排高饱和的基础色, 覆盖「随手调个接近的颜色」的需求 */
const CP_COMMON = [
  '#000000', '#101010', '#1a1a1a', '#242424', '#333333', '#4d4d4d', '#7f7f7f', '#a6a6a6', '#d9d9d9', '#ffffff',
  '#ff5b5b', '#ff8a4c', '#ffc857', '#ffe066', '#8ee36a', '#3ddc84', '#3fd3c6', '#4fc3f7', '#5aa9ff', '#7a6cff',
  '#b48cff', '#d96cf0', '#ff8fc7', '#ff6b9d', '#c0a080', '#e8d48b', '#b99b3f', '#7fae8f', '#5b7c8d', '#8fa5b8',
];

/* 色相刻度: 12 个基准色相 × 3 档明度 */
const CP_HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
const CP_LEVELS = [
  { s: 72, l: 42 },
  { s: 78, l: 58 },
  { s: 62, l: 78 },
];

/* 当前正在调的那一项 */
let cpTarget = '';

/** h 0-360, s/l 0-100 -> '#rrggbb' */
function hslToHex(h, s, l) {
  const H = ((Number(h) % 360) + 360) % 360;
  const S = Math.min(100, Math.max(0, Number(s))) / 100;
  const L = Math.min(100, Math.max(0, Number(l))) / 100;
  const k = (n) => (n + H / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}

/** '#rrggbb' -> {h,s,l}; 认不出来返回 null */
function hexToHsl(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** 松一点的色码解析: 认 #abc / #aabbcc / aabbcc / abc, 其它返回 null */
function looseHex(text) {
  const str = String(text || '').trim().replace(/^#/, '');
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(str)) return null;
  return normalizeHex(`#${str}`);
}

/** 面板里那几片色格子 —— 建一次就够, 之后只换选中态 */
function buildColorPopBody() {
  const common = document.getElementById('cpCommon');
  if (common && !common.dataset.ready) {
    common.dataset.ready = '1';
    common.innerHTML = CP_COMMON.map((c) => `<span class="cp-sw" data-color="${c}"
      style="background:${c}" title="${c}" onclick="usePresetColor('${c}')"></span>`).join('');
    const hues = document.getElementById('cpHues');
    if (hues) {
      const cells = [];
      for (const lv of CP_LEVELS) {
        for (const h of CP_HUES) cells.push(hslToHex(h, lv.s, lv.l));
      }
      hues.innerHTML = cells.map((c) => `<span class="cp-sw" data-color="${c}"
        style="background:${c}" title="${c}" onclick="usePresetColor('${c}')"></span>`).join('');
    }
  }
}

/** 同色调: 拿当前颜色所在色相, 铺 10 档亮度 */
function paintShades(hex) {
  const box = document.getElementById('cpShades');
  if (!box) return;
  const hsl = hexToHsl(hex) || { h: 190, s: 60, l: 50 };
  const levels = [96, 88, 78, 67, 56, 47, 39, 31, 23, 14];
  const cells = levels.map((l) => hslToHex(hsl.h, hsl.s, l));
  box.innerHTML = cells.map((c) => `<span class="cp-sw" data-color="${c}"
    style="background:${c}" title="${c}" onclick="usePresetColor('${c}')"></span>`).join('');
  markSelectedSwatch(hex);
}

/** 把等于当前色的格子圈出来 */
function markSelectedSwatch(hex) {
  const norm = normalizeHex(hex);
  for (const el of document.querySelectorAll('.cp-pop .cp-sw')) {
    el.classList.toggle('sel', String(el.dataset.color).toLowerCase() === norm);
  }
}

/** 打开面板, name 是要调的那一项 */
function pickThemeColor(name) {
  if (!THEME_VARS.some(([n]) => n === name)) return;
  const pop = document.getElementById('cpPop');
  if (!pop) return;
  cpTarget = name;
  const meta = THEME_VARS.find(([n]) => n === name);
  const cols = currentThemeColors();
  const val = normalizeHex(cols[name] || '#000000');

  document.getElementById('cpTitle').textContent = meta ? meta[1] : name;
  document.getElementById('cpVar').textContent = `--${name}`;
  const hexEl = document.getElementById('cpHex');
  hexEl.value = val;
  hexEl.classList.remove('bad');
  const err = document.getElementById('cpErr');
  if (err) err.textContent = '';
  document.getElementById('cpPreview').style.background = cols[name] || val;

  buildColorPopBody();
  paintShades(val);
  markSelectedSwatch(val);
  for (const row of document.querySelectorAll('#themeEditor .te-row')) {
    row.classList.toggle('picking', row.dataset.name === name);
  }

  pop.hidden = false;
  positionColorPop();
  hexEl.focus();
  hexEl.select();
}

/** 面板贴着色块摆, 出界就翻到另一边 */
function positionColorPop() {
  const pop = document.getElementById('cpPop');
  const chip = cpTarget ? document.getElementById(`te_${cpTarget}`) : null;
  if (!pop || pop.hidden || !chip) return;
  const r = chip.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const gap = 9;
  let left = r.right + gap;
  if (left + pr.width > window.innerWidth - 8) left = r.left - pr.width - gap;
  if (left < 8) left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, r.left));
  let top = r.top - 6;
  if (top + pr.height > window.innerHeight - 8) top = window.innerHeight - pr.height - 8;
  if (top < 8) top = 8;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function closeColorPop() {
  const pop = document.getElementById('cpPop');
  if (pop) pop.hidden = true;
  cpTarget = '';
  for (const row of document.querySelectorAll('#themeEditor .te-row.picking')) row.classList.remove('picking');
}

/** 面板里点了一个预设色: 立刻生效 */
function usePresetColor(hex) {
  if (!cpTarget) return;
  const norm = normalizeHex(hex);
  setThemeVar(cpTarget, norm);
  const hexEl = document.getElementById('cpHex');
  if (hexEl) { hexEl.value = norm; hexEl.classList.remove('bad'); }
  const err = document.getElementById('cpErr');
  if (err) err.textContent = '';
  const pv = document.getElementById('cpPreview');
  if (pv) pv.style.background = norm;
  paintShades(norm);
  markSelectedSwatch(norm);
}

/** 边敲边看: 认得出色码就实时上色, 认不出先把输入框标红, 不报错打断打字 */
function onColorInput(text) {
  const hex = looseHex(text);
  const input = document.getElementById('cpHex');
  const err = document.getElementById('cpErr');
  if (!hex) {
    if (input) input.classList.add('bad');
    if (err) err.textContent = String(text).trim() ? '色码要写成 #3fd3c6 或 #3fc 这样' : '';
    return;
  }
  if (input) input.classList.remove('bad');
  if (err) err.textContent = '';
  usePresetColor(hex);
}

/** 回车 / 点「应用」: 敲完统一提交 */
function commitColorInput() {
  const input = document.getElementById('cpHex');
  if (!input) return;
  const hex = looseHex(input.value);
  if (!hex) {
    const err = document.getElementById('cpErr');
    if (err) err.textContent = `「${input.value}」认不出来，要像 #3fd3c6 或 #3fc 这样`;
    input.classList.add('bad');
    return;
  }
  usePresetColor(hex);
  input.value = hex;
  input.select();
}

/** 兜底: 打开系统自带的取色器 */
function openNativePicker() {
  const el = document.getElementById('cpNative');
  const cur = document.getElementById('cpHex');
  const hex = cur ? looseHex(cur.value) : null;
  if (!el) return;
  if (hex) el.value = hex;
  dragColorName = cpTarget;
  if (typeof el.showPicker === 'function') {
    try { el.showPicker(); return; } catch { /* 老浏览器没有, 走下面 */ }
  }
  el.click();
}

function onNativeColor(value) {
  if (!cpTarget) return;
  usePresetColor(value);
  dragColorName = '';
}

/** 在当前色上加减亮度(±8/步), 调暗调亮比重新选色快 */
function adjustColorBrightness(delta) {
  if (!cpTarget) return;
  const cols = currentThemeColors();
  const hsl = hexToHsl(cols[cpTarget]);
  if (!hsl) return;
  const l = Math.min(100, Math.max(0, hsl.l + Number(delta)));
  usePresetColor(hslToHex(hsl.h, hsl.s, l));
}

/** 这一项回到「当前预设」的原始颜色 —— 用来撤销手滑 */
function resetPickedColor() {
  if (!cpTarget) return;
  const idx = themeState.preset < THEMES.length ? themeState.preset : 0;
  const base = presetColors(idx);
  if (!base[cpTarget]) return;
  usePresetColor(base[cpTarget]);
}

/* 点面板外面 / 按 Esc 就把面板收起来 */
document.addEventListener('mousedown', (e) => {
  const pop = document.getElementById('cpPop');
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target)) return;
  // 点在「正在调」的那一行上面不算外面, 否则会立刻又打开
  const row = e.target.closest ? e.target.closest('.te-row') : null;
  if (row && row.dataset.name === cpTarget) return;
  closeColorPop();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const pop = document.getElementById('cpPop');
  if (pop && !pop.hidden) { closeColorPop(); e.stopPropagation(); }
});

window.addEventListener('resize', () => {
  const pop = document.getElementById('cpPop');
  if (pop && !pop.hidden) positionColorPop();
});

/** 把色块涂成当前值 */
function paintThemeChips(cols) {
  for (const [name] of THEME_VARS) {
    const chip = document.getElementById(`te_${name}`);
    if (!chip) continue;
    const v = cols[name];
    chip.style.background = v || 'transparent';
    // 深色块配浅边, 浅色块配深边, 不然一个白块在深底上看不出边界
    const rgb = hexToRgb(v);
    const light = rgb ? (rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000 > 150 : false;
    chip.style.borderColor = light ? 'rgba(0,0,0,.32)' : 'var(--line)';
  }
  // 面板开着的时候跟着一起更新
  if (cpTarget) {
    const pv = document.getElementById('cpPreview');
    if (pv && cols[cpTarget]) pv.style.background = cols[cpTarget];
    const hexEl = document.getElementById('cpHex');
    if (hexEl && document.activeElement !== hexEl && cols[cpTarget]) hexEl.value = normalizeHex(cols[cpTarget]);
  }
}
