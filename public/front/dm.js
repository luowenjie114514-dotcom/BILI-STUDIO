/* 私信形态的 ⚙ 悬浮面板 */
function dmPopEls() {
  return { pop: document.getElementById('dmPop'), btn: document.getElementById('dmSetBtn') };
}

function closeDmPop() {
  const { pop, btn } = dmPopEls();
  if (pop) pop.hidden = true;
  if (btn) btn.classList.remove('on');
}

// v1.5: 面板改成 position:fixed 挂到 body 上 —— 小窗里 flex + 裁切/层叠的坑太多,
// 固定在视口层就永远不会被别的窗口盖住或被裁掉。位置跟着 ⚙ 走, 贴不到边就翻上去。
function applyDmFormTip() {
  const tip = document.getElementById('dmFormTip');
  if (!tip) return;
  const sel = document.querySelector('input[name=dmForm]:checked');
  tip.dataset.form = sel ? sel.value : 'card';
}

// 私信正文字数: 和后端 dmCharLimit() 保持一致的钳制范围
function clampChars(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 10) return 40;
  return Math.min(400, n);
}

function placeDmPop() {
  const { pop, btn } = dmPopEls();
  if (!pop || !btn || pop.hidden) return;
  const r = btn.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight, gap = 6, edge = 8;
  let left = r.left - 6;
  if (left + pr.width > vw - edge) left = vw - edge - pr.width;
  if (left < edge) left = edge;
  let top = r.bottom + gap;
  if (top + pr.height > vh - edge) {
    const above = r.top - gap - pr.height;
    top = above >= edge ? above : Math.max(edge, vh - edge - pr.height);
  }
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(top) + 'px';
}

function toggleDmPop(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  const { pop, btn } = dmPopEls();
  if (!pop) return;
  const willShow = pop.hidden;
  if (willShow && pop.parentElement !== document.body) document.body.appendChild(pop);
  pop.hidden = !willShow;
  if (btn) btn.classList.toggle('on', willShow);
  if (willShow) placeDmPop();
}

/* 顶层事件绑定 */
addEventListener('resize', () => { if (!document.getElementById('dmPop')?.hidden) placeDmPop(); });
addEventListener('scroll', () => { if (!document.getElementById('dmPop')?.hidden) placeDmPop(); }, true);

document.addEventListener('click', (e) => {
  const { pop } = dmPopEls();
  if (!pop || pop.hidden) return;
  // v1.5: 面板可能被挪到了 body 下, 用 contains 判断比 closest 更稳
  if (pop.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.dmgear-wrap')) return;
  closeDmPop();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeDmPop(); closeChangelog(); }
});
