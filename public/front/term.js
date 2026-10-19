/* 站内终端 */
const TERM_GEOM_KEY = 'bili-studio.termWin';
const term = { seq: 0, visible: false, timer: null, hist: [], hi: -1 };

function termEl() {
  return document.getElementById('termWin');
}

function saveTermGeom() {
  const w = termEl();
  if (!w || w.hidden) return;
  try {
    const r = w.getBoundingClientRect();
    localStorage.setItem(TERM_GEOM_KEY, JSON.stringify({
      left: Math.round(r.left), top: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
    }));
  } catch { /* 隐私模式没 localStorage, 忽略 */ }
}

function restoreTermGeom() {
  const w = termEl();
  if (!w) return;
  let g = null;
  try { g = JSON.parse(localStorage.getItem(TERM_GEOM_KEY) || 'null'); } catch { g = null; }
  if (!g || !Number.isFinite(g.left)) return;
  const wd = Math.min(g.w || 640, window.innerWidth - 24);
  const ht = Math.min(g.h || 390, window.innerHeight - 90);
  w.style.width = wd + 'px';
  w.style.height = ht + 'px';
  w.style.left = Math.max(8, Math.min(g.left, window.innerWidth - wd - 8)) + 'px';
  w.style.top = Math.max(8, Math.min(g.top, window.innerHeight - ht - 8)) + 'px';
  w.style.right = 'auto';
}

function termLineNode(l) {
  const d = document.createElement('div');
  d.className = 'tl s-' + (l.stream || 'out');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = l.time || '';
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = l.text || '';
  d.append(t, x);
  return d;
}

async function pollTerm() {
  const out = document.getElementById('termOut');
  const body = document.getElementById('termBody');
  if (!out || !body || !term.visible) return;
  try {
    const r = await api('/api/term?since=' + term.seq);
    if (typeof r.seq === 'number' && r.seq < term.seq) {
      out.innerHTML = '';   // 服务端清过屏或重启过, 从头对齐
      term.seq = 0;
    }
    if (Array.isArray(r.lines) && r.lines.length) {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      for (const l of r.lines) out.appendChild(termLineNode(l));
      while (out.childElementCount > 1200) out.firstElementChild.remove();
      if (atBottom) body.scrollTop = body.scrollHeight;
    }
    if (typeof r.seq === 'number') term.seq = r.seq;
    const cwd = document.getElementById('termCwd');
    if (cwd && r.cwd) { cwd.textContent = r.cwd; cwd.title = r.cwd; }
    const st = document.getElementById('termState');
    if (st) st.textContent = r.running ? '运行中…' : '空闲';
  } catch { /* 服务没起来也别刷屏 */ }
}

function showTerm() {
  const w = termEl();
  if (!w) return;
  term.visible = true;
  w.hidden = false;
  restoreTermGeom();
  w.style.zIndex = 120;
  pollTerm();
  clearInterval(term.timer);
  term.timer = setInterval(pollTerm, 900);
  setTimeout(() => {
    const inp = document.getElementById('termIn');
    if (inp) inp.focus();
  }, 40);
}

function hideTerm() {
  const w = termEl();
  if (!w) return;
  term.visible = false;
  w.hidden = true;
  clearInterval(term.timer);
  term.timer = null;
}

async function termRun() {
  const inp = document.getElementById('termIn');
  if (!inp) return;
  const cmd = inp.value.trim();
  if (!cmd) return;
  inp.value = '';
  term.hist.push(cmd);
  term.hi = term.hist.length;
  const low = cmd.toLowerCase();
  if (low === 'cls' || low === 'clear') { await termClear(); return; }
  try {
    await api('/api/term/exec', { cmd });
    setTimeout(pollTerm, 60);
  } catch (e) {
    toast('执行失败: ' + e.message, 'err');
  }
}

async function termStop() {
  try {
    const r = await api('/api/term/kill', {});
    if (!r.ok) toast(r.message || '没有在跑的命令');
  } catch (e) {
    toast('停止失败: ' + e.message, 'err');
  }
  setTimeout(pollTerm, 60);
}

async function termClear() {
  const out = document.getElementById('termOut');
  if (out) out.innerHTML = '';
  term.seq = 0;
  try { await api('/api/term/clear', {}); } catch { /* ignore */ }
}

function initTerm() {
  const w = termEl();
  if (!w) return;
  const head = w.querySelector('.win-head');
  const body = document.getElementById('termBody');
  const inp = document.getElementById('termIn');
  if (!head || !body || !inp) return;

  let sx = 0; let sy = 0; let ox = 0; let oy = 0; let dragging = false;

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const r = w.getBoundingClientRect();
    dragging = true;
    sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
    w.style.right = 'auto';
    w.style.zIndex = 120;
    head.setPointerCapture?.(e.pointerId);
  });

  head.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const wd = w.offsetWidth; const ht = w.offsetHeight;
    w.style.left = Math.max(4, Math.min(ox + e.clientX - sx, window.innerWidth - wd - 4)) + 'px';
    w.style.top = Math.max(4, Math.min(oy + e.clientY - sy, window.innerHeight - ht - 4)) + 'px';
    e.preventDefault();
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    head.releasePointerCapture?.(e.pointerId);
    saveTermGeom();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);

  // 拖右下角改大小之后也记住尺寸
  if (typeof ResizeObserver === 'function') {
    let t = null;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(saveTermGeom, 400);
    }).observe(w);
  }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      termRun();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (term.hi > 0) {
        term.hi -= 1;
        inp.value = term.hist[term.hi] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (term.hi < term.hist.length - 1) {
        term.hi += 1;
        inp.value = term.hist[term.hi] || '';
      } else {
        term.hi = term.hist.length;
        inp.value = '';
      }
    }
  });

  body.addEventListener('click', () => inp.focus());
}
