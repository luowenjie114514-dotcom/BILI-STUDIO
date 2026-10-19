/* 更新日志弹窗(markdown -> html) */
let clLoaded = false;

/** 极简 markdown -> html: 只认标题/列表/粗体/行内代码/分隔线, 够看日志就行 */
function miniMarkdown(src) {
  // 先把缩进的续行接回上一行: 否则一条要点会被拆成一个 li + 一个 p, 看着很散
  const lines = [];
  for (const raw of String(src || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    const isCont = /^\s{2,}\S/.test(line) && !/^\s*([-*]|\d+\.)\s+/.test(line) && !/^#/.test(line.trim());
    if (isCont && lines.length && lines[lines.length - 1].trim()) {
      lines[lines.length - 1] = `${lines[lines.length - 1].trimEnd()} ${line.trim()}`;
    } else {
      lines.push(line);
    }
  }
  const out = [];
  let inList = false;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeList();
      const lv = Math.min(3, h[1].length);
      const text = inline(h[2]);
      // 形如 "## [1.4.1] — 2026-10-18" 的版本行, 尾巴上挂个版本小标
      const ver = h[2].match(/\[([\d.]+)\]/);
      out.push(`<h${lv}>${text}${ver ? `<span class="cl-pill">v${ver[1]}</span>` : ''}</h${lv}>`);
      continue;
    }
    const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(li[2])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

async function openChangelog() {
  const wrap = document.getElementById('clWrap');
  const body = document.getElementById('clBody');
  if (!wrap || !body) return;
  wrap.hidden = false;
  body.scrollTop = 0;
  if (clLoaded) return;
  try {
    const r = await api('/api/changelog');
    const ver = document.getElementById('clVer');
    if (ver) ver.textContent = r.version ? '当前 v' + r.version : '';
    body.innerHTML = r.text
      ? miniMarkdown(r.text)
      : '<div class="kv">这个版本里没带更新日志（源码模式请确认项目根有 CHANGELOG.md）</div>';
    clLoaded = true;
  } catch (e) {
    body.innerHTML = `<div class="kv">读取更新日志失败：${esc(e.message)}</div>`;
  }
}

function closeChangelog() {
  const wrap = document.getElementById('clWrap');
  if (wrap && !wrap.hidden) wrap.hidden = true;
}
