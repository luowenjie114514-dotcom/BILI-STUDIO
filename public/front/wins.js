/* 小窗工作区: 拖动 / 收起 / 关闭 / 布局 */
const WIN_KEY = 'bili-studio.wins.v2';
const WIN_DEFS = [
  ['run', '运行', 380],
  ['acc', '账户', 440],
  ['men', '名单', 470],
  ['pref', '内容偏好', 420],
  ['style', '风格与署名', 420],
  ['task', '任务参数', 470],
  ['sch', '自动任务', 480],
  ['ai', 'AI 接口', 470],
  ['skin', '皮肤与主题', 430],
  ['log', '运行日志', 540],
  ['hist', '任务历史', 640],
];
const wins = { list: [], byId: {}, zTop: 10, ready: false };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function initWins() {
  const ws = document.getElementById('workspace');
  if (!ws || wins.ready) return;

  const cards = [...ws.children].filter((el) => el.classList && el.classList.contains('card'));
  cards.forEach((card, i) => {
    const def = WIN_DEFS[i] || [`w${i}`, `窗口 ${i + 1}`, 420];
    const h2 = card.querySelector(':scope > h2');
    let n = '';
    let title = def[1];
    if (h2) {
      const badge = h2.querySelector('.n');
      n = badge ? badge.textContent.trim() : '';
      const copy = h2.cloneNode(true);
      const b2 = copy.querySelector('.n');
      if (b2) b2.remove();
      title = copy.textContent.trim() || def[1];
      h2.remove();
    }
    const el = document.createElement('section');
    el.className = 'win';
    el.dataset.win = def[0];
    el.innerHTML = `<div class="win-head">
        ${n ? `<span class="win-n">${esc(n)}</span>` : ''}
        <span class="win-t">${esc(title)}</span>
        <span class="win-sp"></span>
        <button class="win-btn" type="button" data-act="min" title="收起到标题栏">—</button>
        <button class="win-btn" type="button" data-act="close" title="关掉（顶栏「窗口」里能再打开）">✕</button>
      </div>
      <div class="win-body"></div>
      <div class="win-grip" title="拖这里改大小"></div>`;
    const body = el.querySelector('.win-body');
    while (card.firstChild) body.appendChild(card.firstChild);
    // 标了 win-keep 的操作行不跟着内容滚, 搬成吸底的操作栏
    const keep = body.querySelector('.win-keep');
    if (keep) {
      const foot = document.createElement('div');
      foot.className = 'win-foot';
      foot.appendChild(keep);
      keep.style.margin = '0';
      el.insertBefore(foot, el.querySelector('.win-grip'));
    }
    card.remove();
    ws.appendChild(el);
    wins.list.push({ id: def[0], title: def[1], name: title, el, body });
  });

  const sp = document.createElement('div');
  sp.id = 'wsSpacer';
  ws.appendChild(sp);
  wins.spacer = sp;
  wins.byId = Object.fromEntries(wins.list.map((w) => [w.id, w]));
  wins.ready = true;

  bindWinEvents();
  const saved = loadWinState();
  if (saved) applyWinState(saved); else defaultWinLayout();
  renderWinMenu();
  syncSpacer();
  updateRecallPill();
}

function geomOf(w) {
  const s = w.el.style;
  return {
    x: parseFloat(s.left) || 0, y: parseFloat(s.top) || 0,
    w: parseFloat(s.width) || 380, h: parseFloat(s.height) || 240,
  };
}

// 窗口里除了正文还要占的高度: 标题栏 + 吸底操作栏 + 内边距
function winChrome(w) {
  const head = w.el.querySelector('.win-head');
  const foot = w.el.querySelector('.win-foot');
  return (head ? head.offsetHeight : 34) + (foot ? foot.offsetHeight : 0) + 24;
}

function setGeom(w, g) {
  const s = w.el.style;
  if (g.x !== undefined) s.left = `${Math.round(g.x)}px`;
  if (g.y !== undefined) s.top = `${Math.round(g.y)}px`;
  if (g.w !== undefined) s.width = `${Math.round(g.w)}px`;
  if (g.h !== undefined) s.height = `${Math.round(g.h)}px`;
}

function defaultWinLayout() {
  const ws = document.getElementById('workspace');
  const W = ws.clientWidth || document.documentElement.clientWidth;
  const cols = W >= 1180 ? 3 : W >= 800 ? 2 : 1;
  const pad = 14;
  const gap = 14;
  const colW = Math.max(260, Math.floor((W - pad * 2 - gap * (cols - 1)) / cols));
  const bottoms = new Array(cols).fill(pad);
  // 一屏能摆多少就摆多少: 尽量让每个窗口都落在「当前视口」内,
  // 放不下的才往下续一屏, 免得按钮落在 1500px 之外要滚滚滚才能点。
  const viewH = Math.max(360, (ws.clientHeight || window.innerHeight) - pad * 2);
  const maxCapped = Math.round(window.innerHeight * 0.78);
  for (const w of wins.list) {
    w.el.hidden = false;
    w.el.classList.remove('min');
    w.el.style.width = `${colW}px`;
    w.el.style.height = '';
    w.el.style.position = '';
    w.el.style.left = '';
    w.el.style.top = '';
    w.el.style.right = '';
    w.el.style.bottom = '';
    const need = w.body.scrollHeight + winChrome(w);
    const h = clamp(need, 110, maxCapped);
    // 优先塞进「还没超出一屏」的列; 都塞不下了, 再挑最短的列续到下一屏
    let c = -1;
    for (let i = 0; i < cols; i++) {
      if (bottoms[i] + h <= viewH) { if (c < 0 || bottoms[i] < bottoms[c]) c = i; }
    }
    if (c < 0) { c = 0; for (let i = 1; i < cols; i++) if (bottoms[i] < bottoms[c] - 1) c = i; }
    setGeom(w, { x: pad + c * (colW + gap), y: bottoms[c], w: colW, h });
    bottoms[c] += h + gap;
  }
  syncSpacer();
  saveWinState();
}

function tileAllWins() {
  // 只重排「显示中」的窗口, 隐藏的保持隐藏; 已最小化的不动高度
  const shown = wins.list.filter((w) => !w.el.hidden);
  if (!shown.length) { toast('没有显示中的窗口'); return; }
  const ws = document.getElementById('workspace');
  const W = ws.clientWidth || document.documentElement.clientWidth;
  const cols = W >= 1180 ? 3 : W >= 800 ? 2 : 1;
  const pad = 14;
  const gap = 14;
  const colW = Math.max(260, Math.floor((W - pad * 2 - gap * (cols - 1)) / cols));
  const viewH = Math.max(360, (ws.clientHeight || window.innerHeight) - pad * 2);
  const maxCapped = Math.round(window.innerHeight * 0.78);
  const bottoms = new Array(cols).fill(pad);
  for (const w of shown) {
    w.el.style.width = `${colW}px`;
    if (w.el.classList.contains('min')) {
      let mc = 0;
      for (let i = 1; i < cols; i++) if (bottoms[i] < bottoms[mc] - 1) mc = i;
      setGeom(w, { x: pad + mc * (colW + gap), y: bottoms[mc] });
      bottoms[mc] += 46 + gap;
      continue;
    }
    const need = w.body.scrollHeight + winChrome(w);
    const h = clamp(need, 110, maxCapped);
    // 优先塞进「还没超出一屏」的列; 都塞不下了, 再挑最短的列续到下一屏
    let c = -1;
    for (let i = 0; i < cols; i++) {
      if (bottoms[i] + h <= viewH) { if (c < 0 || bottoms[i] < bottoms[c]) c = i; }
    }
    if (c < 0) { c = 0; for (let i = 1; i < cols; i++) if (bottoms[i] < bottoms[c] - 1) c = i; }
    setGeom(w, { x: pad + c * (colW + gap), y: bottoms[c], w: colW, h });
    bottoms[c] += h + gap;
  }
  syncSpacer();
  saveWinState();
  toast('已把窗口排回屏幕内', 'ok');
}

// 从「窗口」菜单点开一扇窗时, 顺手把工作区滚到它那儿 —— 一屏装不下时这就是唯一找得到它的办法
function scrollWinIntoView(w) {
  if (!w || w.el.hidden) return;
  requestAnimationFrame(() => {
    const ws = document.getElementById('workspace');
    const top = parseFloat(w.el.style.top) || 0;
    const wr = w.el.getBoundingClientRect();
    const viewTop = ws.getBoundingClientRect().top;
    // 整扇窗都在可视区里就别乱滚
    if (wr.top >= viewTop + 4 && wr.bottom <= viewTop + ws.clientHeight - 4) return;
    ws.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
  });
}

function applyWinState(saved) {
  const ws = document.getElementById('workspace');
  const W = ws.clientWidth || document.documentElement.clientWidth;
  let need = 0;
  wins.list.forEach((w, i) => {
    const s = saved[w.id];
    if (s) {
      w.el.hidden = !!s.hidden;
      w.el.classList.toggle('min', !!s.min);
      setGeom(w, { x: s.x, y: s.y, w: s.w, h: s.h });
    } else {
      setGeom(w, { x: 14 + (i % 3) * 440, y: 14 + Math.floor(i / 3) * 300, w: 430, h: 280 });
    }
    const g = geomOf(w);
    const maxX = Math.max(0, W - 80);
    if (g.x > maxX) setGeom(w, { x: maxX });
    if (g.y < 0) setGeom(w, { y: 0 });
    const g2 = geomOf(w);
    if (!w.el.hidden) need = Math.max(need, g2.y + g2.h);
  });
  syncSpacer(need);
}

function loadWinState() {
  try {
    const raw = localStorage.getItem(WIN_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveWinState() {
  if (!wins.ready) return;
  const out = {};
  for (const w of wins.list) {
    const g = geomOf(w);
    out[w.id] = {
      x: Math.round(g.x), y: Math.round(g.y), w: Math.round(g.w), h: Math.round(g.h),
      min: w.el.classList.contains('min'), hidden: w.el.hidden,
    };
  }
  try { localStorage.setItem(WIN_KEY, JSON.stringify(out)); } catch { /* 忽略配额错误 */ }
}

function syncSpacer(minHeight) {
  if (!wins.spacer) return;
  let bottom = minHeight || 0;
  for (const w of wins.list) {
    if (w.el.hidden) continue;
    const g = geomOf(w);
    bottom = Math.max(bottom, g.y + g.h);
  }
  wins.spacer.style.height = `${Math.round(bottom) + 28}px`;
}

function focusWin(w) {
  if (w.el.classList.contains('focus')) return;
  for (const o of wins.list) o.el.classList.remove('focus');
  w.el.classList.add('focus');
  w.el.style.zIndex = String(++wins.zTop);
}

function toggleWinMin(w) {
  w.el.classList.toggle('min');
  if (w.el.classList.contains('min')) {
    const g = geomOf(w);
    w.restoreH = g.h;
    setGeom(w, { h: 0 });
    w.el.style.height = '';           // 让 .min 自然收成标题栏高
  } else if (w.restoreH) {
    setGeom(w, { h: w.restoreH });
  }
  syncSpacer();
  saveWinState();
  applyLogMiniVisibility();
}

function hideWin(w) {
  w.el.hidden = true;
  syncSpacer();
  saveWinState();
  renderWinMenu();
  updateRecallPill();
  applyLogMiniVisibility();
}

function showWin(w) {
  w.el.hidden = false;
  focusWin(w);
  syncSpacer();
  saveWinState();
  renderWinMenu();
  updateRecallPill();
  applyLogMiniVisibility();
}

function toggleWinById(id) {
  const w = wins.byId[id];
  if (!w) return;
  if (w.el.hidden) { showWin(w); scrollWinIntoView(w); } else hideWin(w);
}

function showAllWins() {
  for (const w of wins.list) w.el.hidden = false;
  syncSpacer();
  saveWinState();
  renderWinMenu();
  updateRecallPill();
}

function collapseAllWins() {
  for (const w of wins.list) {
    w.el.hidden = false;
    if (!w.el.classList.contains('min')) toggleWinMin(w);
  }
  syncSpacer();
  saveWinState();
  renderWinMenu();
  updateRecallPill();
}

function recallAllWins() {
  showAllWins();
  toast('窗口都叫回来了', 'ok');
}

function resetWinLayout() {
  try { localStorage.removeItem(WIN_KEY); } catch { /* ignore */ }
  for (const w of wins.list) {
    w.el.hidden = false;
    w.el.classList.remove('min');
    w.el.style.height = '';
    w.el.style.zIndex = '';
  }
  defaultWinLayout();
  renderWinMenu();
  updateRecallPill();
  toast('布局已重置', 'ok');
}

function updateRecallPill() {
  const pill = document.getElementById('recallPill');
  if (!pill) return;
  const anyVisible = wins.list.some((w) => !w.el.hidden);
  pill.hidden = anyVisible;
}

function renderWinMenu() {
  const box = document.getElementById('winPopList');
  if (!box) return;
  box.innerHTML = wins.list.map((w) => `
    <label><input type="checkbox" data-winbox="${w.id}" ${w.el.hidden ? '' : 'checked'} onchange="toggleWinById('${w.id}')">
    ${esc(w.name)}</label>`).join('');
}

function toggleWinMenu(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const pop = document.getElementById('winPop');
  if (!pop) return;
  pop.hidden = !pop.hidden;
  if (!pop.hidden) renderWinMenu();
}

function closeWinMenu() {
  const pop = document.getElementById('winPop');
  if (pop) pop.hidden = true;
}

function bindWinEvents() {
  for (const w of wins.list) {
    const { el } = w;
    el.addEventListener('pointerdown', () => focusWin(w), true);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('.win-btn');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      if (b.dataset.act === 'min') toggleWinMin(w);
      else if (b.dataset.act === 'close') hideWin(w);
    });
    el.querySelector('.win-head').addEventListener('pointerdown', (e) => startWinDrag(e, w, 'move'));
    el.querySelector('.win-grip').addEventListener('pointerdown', (e) => startWinDrag(e, w, 'size'));
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.winmenu-wrap')) closeWinMenu();
  });
  window.addEventListener('resize', () => {
    const ws = document.getElementById('workspace');
    const W = ws.clientWidth || 0;
    for (const w of wins.list) {
      const g = geomOf(w);
      if (g.x > W - 80) setGeom(w, { x: Math.max(0, W - 80) });
    }
    syncSpacer();
  });
}

function startWinDrag(e, w, mode) {
  if (e.button !== 0) return;
  if (e.target.closest('.win-btn')) return;
  e.preventDefault();
  const ws = document.getElementById('workspace');
  const target = e.currentTarget;
  const start = { cx: e.clientX, cy: e.clientY, g: geomOf(w) };
  const wsW = ws.clientWidth;
  w.el.classList.add('drag');
  focusWin(w);
  try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }

  const onMove = (ev) => {
    const dx = ev.clientX - start.cx;
    const dy = ev.clientY - start.cy;
    if (mode === 'move') {
      setGeom(w, {
        x: clamp(start.g.x + dx, 0, Math.max(0, wsW - 80)),
        y: Math.max(0, start.g.y + dy),
      });
    } else {
      setGeom(w, {
        w: clamp(start.g.w + dx, 260, Math.max(320, wsW - start.g.x)),
        h: clamp(start.g.h + dy, 90, 2400),
      });
    }
    syncSpacer();
  };
  const onUp = () => {
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    w.el.classList.remove('drag');
    syncSpacer();
    saveWinState();
  };
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
}
