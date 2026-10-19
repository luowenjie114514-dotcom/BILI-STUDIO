/* 运行日志与右上角日志小窗 */
let miniDismissed = false;   // 主人亲手 ✕ 掉之后, 等完整日志重新可见再允许自动弹出
let miniJustDragged = false; // 刚拖完窗口, 这次 pointerup 之后的 click 不算「收起/展开」

function toggleMiniDock(e) {
  if (e) e.stopPropagation();
  if (miniJustDragged) { miniJustDragged = false; return; }
  const m = document.getElementById('logMini');
  if (!m) return;
  const wasDocked = m.classList.contains('dock');
  if (!wasDocked) {
    // 收成一条: 把内联的宽高先存起来, 否则内联样式会盖掉 .dock 的 auto
    m.dataset.prevW = m.style.width;
    m.dataset.prevH = m.style.height;
    m.style.width = '';
    m.style.height = '';
    m.classList.add('dock');
    return;
  }
  m.classList.remove('dock');
  m.style.width = m.dataset.prevW || '';
  m.style.height = m.dataset.prevH || '';
  const body = document.getElementById('miniLog');
  if (body) body.scrollTop = body.scrollHeight;
  saveMiniGeom();
}

function closeLogMini(e) {
  if (e) e.stopPropagation();
  miniDismissed = true;
  const m = document.getElementById('logMini');
  if (m) m.hidden = true;
  const pill = document.getElementById('logMiniPill');
  if (pill) pill.hidden = false;
}

function openLogMini() {
  miniDismissed = false;
  const pill = document.getElementById('logMiniPill');
  if (pill) pill.hidden = true;
  const m = document.getElementById('logMini');
  if (m) { m.hidden = false; m.classList.remove('dock'); }
  const body = document.getElementById('miniLog');
  if (body) body.scrollTop = body.scrollHeight;
}

function gotoFullLog(e) {
  if (e) e.stopPropagation();
  // v1.5: 完整日志是个小窗, 可能被关掉了 —— 先叫回来再滚过去
  const w = wins.byId.log;
  if (w && w.el.hidden) showWin(w);
  if (w && w.el.classList.contains('min')) toggleWinMin(w);
  const box = document.getElementById('log');
  if (!box) return;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.style.transition = 'box-shadow .2s';
  box.style.boxShadow = '0 0 0 2px rgba(95,200,255,.55)';
  setTimeout(() => { box.style.boxShadow = ''; }, 1200);
  setTimeout(pollLogs, 60);
}

// 完整日志窗口滚出视野 → 也用小窗顶上(保留老行为); 滚回来 → 收掉
let logWinOnScreen = true;
const MINI_POS_KEY = 'bili-studio.miniWin';

function logLineNode(l) {
  const d = document.createElement('div');
  d.innerHTML = `<span class="l-time">[${esc(l.time)}]</span> `
    + `<span class="l-${esc(l.level)}">${esc(l.message)}</span>`
    + (l.extra?.url ? ` <a href="${esc(l.extra.url)}" target="_blank" rel="noreferrer">打开</a>` : '');
  return d;
}

// 小窗里「还没有日志」占位: 有日志就藏起来, 顺便把窗压矮一点
function syncMiniEmpty() {
  const body = document.getElementById('miniLog');
  const hint = document.getElementById('miniEmpty');
  const mini = document.getElementById('logMini');
  if (!body || !hint || !mini) return;
  const n = [...body.children].filter((c) => c.id !== 'miniEmpty').length;
  hint.hidden = n > 0;
  body.hidden = false;
  mini.classList.toggle('empty', n === 0);
}

async function pollLogs() {
  try {
    const r = await api(`/api/logs?since=${logSeq}`);
    logSeq = r.seq;
    // 同一批日志同时喂给「完整日志」和「右上角小窗」
    for (const id of ['log', 'miniLog']) {
      const box = document.getElementById(id);
      if (!box) continue;
      const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
      for (const l of r.logs) box.appendChild(logLineNode(l));
      while ([...box.children].filter((c) => c.id !== 'miniEmpty').length > 500) {
        const victim = [...box.children].find((c) => c.id !== 'miniEmpty');
        if (!victim) break;
        victim.remove();
      }
      if (stick) box.scrollTop = box.scrollHeight;
    }
    syncMiniEmpty();
    const running = !!r.running;
    const dot = document.getElementById('miniDot');
    const pillDot = document.getElementById('miniPillDot');
    if (dot) dot.classList.toggle('live', running);
    if (pillDot) pillDot.classList.toggle('live', running);
    const cnt = document.getElementById('miniCount');
    if (cnt) cnt.textContent = running ? '运行中…' : '空闲';

    const badge = document.getElementById('runBadge');
    badge.textContent = r.running ? '任务运行中…' : '空闲';
    badge.className = 'badge ' + (r.running ? 'live' : '');
    document.getElementById('runBtn').disabled = r.running;
    document.getElementById('stopBtn').disabled = !r.running;
  } catch { /* 服务没起来就先安静 */ }
}

function toggleMiniDock(e) {
  if (e) e.stopPropagation();
  if (miniJustDragged) { miniJustDragged = false; return; }
  const m = document.getElementById('logMini');
  if (!m) return;
  const wasDocked = m.classList.contains('dock');
  if (!wasDocked) {
    // 收成一条: 把内联的宽高先存起来, 否则内联样式会盖掉 .dock 的 auto
    m.dataset.prevW = m.style.width;
    m.dataset.prevH = m.style.height;
    m.style.width = '';
    m.style.height = '';
    m.classList.add('dock');
    return;
  }
  m.classList.remove('dock');
  m.style.width = m.dataset.prevW || '';
  m.style.height = m.dataset.prevH || '';
  const body = document.getElementById('miniLog');
  if (body) body.scrollTop = body.scrollHeight;
  saveMiniGeom();
}

function closeLogMini(e) {
  if (e) e.stopPropagation();
  miniDismissed = true;
  const m = document.getElementById('logMini');
  if (m) m.hidden = true;
  const pill = document.getElementById('logMiniPill');
  if (pill) pill.hidden = false;
}

function openLogMini() {
  miniDismissed = false;
  const pill = document.getElementById('logMiniPill');
  if (pill) pill.hidden = true;
  const m = document.getElementById('logMini');
  if (m) { m.hidden = false; m.classList.remove('dock'); }
  const body = document.getElementById('miniLog');
  if (body) body.scrollTop = body.scrollHeight;
}

function gotoFullLog(e) {
  if (e) e.stopPropagation();
  // v1.5: 完整日志是个小窗, 可能被关掉了 —— 先叫回来再滚过去
  const w = wins.byId.log;
  if (w && w.el.hidden) showWin(w);
  if (w && w.el.classList.contains('min')) toggleWinMin(w);
  const box = document.getElementById('log');
  if (!box) return;
  box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box.style.transition = 'box-shadow .2s';
  box.style.boxShadow = '0 0 0 2px rgba(95,200,255,.55)';
  setTimeout(() => { box.style.boxShadow = ''; }, 1200);
  setTimeout(pollLogs, 60);
}

function watchLogVisibility() {
  const box = document.getElementById('log');
  if (!box || typeof IntersectionObserver !== 'function') return;
  const io = new IntersectionObserver((list) => {
    for (const en of list) {
      logWinOnScreen = en.isIntersecting;
      applyLogMiniVisibility();
    }
  }, { rootMargin: '-70px 0px 0px 0px', threshold: 0.1 });
  io.observe(box);
}

// 日志窗口被关掉/收起/滚出视野时, 小窗直接顶上(不然就彻底看不到日志了);
// 窗口好好地在屏幕上时就把小窗收掉, 别挡地方。
function logWinUnavailable() {
  const w = wins.byId.log;
  return !w || w.el.hidden || w.el.classList.contains('min') || !logWinOnScreen;
}

function applyLogMiniVisibility() {
  const mini = document.getElementById('logMini');
  const pill = document.getElementById('logMiniPill');
  if (!mini) return;
  if (!logWinUnavailable()) {
    if (!mini.hidden) {
      mini.hidden = true;
      mini.classList.remove('dock');
    }
    if (pill) pill.hidden = true;
    miniDismissed = false;
    return;
  }
  if (miniDismissed) return;
  mini.hidden = false;
  mini.classList.remove('dock');
  const body = document.getElementById('miniLog');
  if (body) body.scrollTop = body.scrollHeight;
}

async function clearLogs() {
  await api('/api/logs/clear', {});
  const full = document.getElementById('log');
  if (full) full.innerHTML = '';
  const mini = document.getElementById('miniLog');
  if (mini) mini.innerHTML = '<div class="kv" id="miniEmpty">还没有日志 · 跑一次任务就有啦～</div>';
  syncMiniEmpty();
  logSeq = 0;
}

function saveMiniGeom() {
  const m = document.getElementById('logMini');
  if (!m || m.hidden || m.classList.contains('dock')) return;
  try {
    const r = m.getBoundingClientRect();
    localStorage.setItem(MINI_POS_KEY, JSON.stringify({
      left: Math.round(r.left), top: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    }));
  } catch { /* 隐私模式没 localStorage, 忽略 */ }
}

/** 把上次的位置/尺寸套回去(只在窗口够大时; 越界的坐标会被夹回视口) */
function restoreMiniGeom() {
  const m = document.getElementById('logMini');
  if (!m) return;
  let g = null;
  try { g = JSON.parse(localStorage.getItem(MINI_POS_KEY) || 'null'); } catch { g = null; }
  if (!g || !Number.isFinite(g.left)) return;
  const w = Math.min(g.w || 392, window.innerWidth - 24);
  const h = Math.min(g.h || 264, window.innerHeight - 80);
  m.style.width = w + 'px';
  m.style.height = h + 'px';
  m.style.left = Math.max(8, Math.min(g.left, window.innerWidth - w - 8)) + 'px';
  m.style.top = Math.max(8, Math.min(g.top, window.innerHeight - h - 8)) + 'px';
  m.style.right = 'auto';
}

function initMiniDrag() {
  const m = document.getElementById('logMini');
  if (!m) return;
  const head = m.querySelector('.logmini-head');
  let sx = 0; let sy = 0; let ox = 0; let oy = 0; let moved = false; let dragging = false;

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.logmini-x')) return;   // ✕ 按钮不拖
    const r = m.getBoundingClientRect();
    dragging = true; moved = false;
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    head.setPointerCapture?.(e.pointerId);
  });

  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx; const dy = e.clientY - sy;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 5) return;   // 抖动不算拖
    if (!moved) {
      moved = true;
      m.classList.add('drag');
      m.style.right = 'auto';
      m.style.width = m.getBoundingClientRect().width + 'px';
      m.style.height = m.getBoundingClientRect().height + 'px';
    }
    const w = m.offsetWidth; const h = m.offsetHeight;
    const left = Math.max(4, Math.min(ox + dx, window.innerWidth - w - 4));
    const top = Math.max(4, Math.min(oy + dy, window.innerHeight - h - 4));
    m.style.left = left + 'px';
    m.style.top = top + 'px';
    e.preventDefault();
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    head.releasePointerCapture?.(e.pointerId);
    m.classList.remove('drag');
    if (moved) {
      // 拖完之后别让这次 pointerup 触发标题栏的「收起/展开」
      miniJustDragged = true;
      setTimeout(() => { miniJustDragged = false; }, 300);
      saveMiniGeom();
    }
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);

  // 拖右侧/底边改大小后也记住尺寸
  if (typeof ResizeObserver === 'function') {
    let t = null;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(saveMiniGeom, 400);
    }).observe(m);
  }
}
