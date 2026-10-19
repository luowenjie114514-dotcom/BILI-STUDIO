/**
 * 把 public/whale.svg 内联进 public/index.html（`<!-- WHALE:BEGIN -->` 到 `<!-- WHALE:END -->` 之间）。
 *
 * 为什么要内联而不是 `<img src="whale.svg">`:
 *   打包成 exe 后静态资源来自 EMBED 表, 多一个文件就要在 build.mjs 的 ASSETS 里登记一次;
 *   而且 `<img>` 里的 SVG 不继承页面的 CSS 变量, 主题色改了鲸鱼娘不会跟着变。
 *   内联成 `<symbol>` 之后, 页面里任何地方 `<use href="#whaleGirl"/>` 就能复用,
 *   渐变 id 加 `wh-` 前缀防止和页面其他 SVG 撞名。
 *
 * 用法: node tools/inline-whale.mjs   （build.mjs 里也会自动调一次）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_FILE = path.join(ROOT, 'public', 'whale.svg');
const HTML_FILE = path.join(ROOT, 'public', 'index.html');

const BEGIN = '<!-- WHALE:BEGIN -->';
const END = '<!-- WHALE:END -->';

const svg = await fsp0(SVG_FILE);
const html = await fsp0(HTML_FILE);

async function fsp0(f) { return fs.readFile(f, 'utf8'); }

/** 取出 <svg> 的内容(丢掉根标签), 并把所有 id 加上 wh- 前缀 */
function toSymbol(raw) {
  const inner = raw
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .trim();

  // 收集所有 id, 逐个改成 wh-xxx, 引用处(url(#x) / href="#x")同步改
  const ids = [...inner.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  let out = inner;
  for (const id of ids) {
    const nid = `wh-${id}`;
    out = out
      .replaceAll(`id="${id}"`, `id="${nid}"`)
      .replaceAll(`url(#${id})`, `url(#${nid})`)
      .replaceAll(`href="#${id}"`, `href="#${nid}"`);
  }

  // 缩进整理
  out = out.split('\n').map((l) => (l.trim() ? '  ' + l : l)).join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true">
  <symbol id="whaleGirl" viewBox="0 0 200 200">
${out}
  </symbol>
</svg>`;
}

const block = `${BEGIN}
${toSymbol(svg)}
${END}`;

const re = new RegExp(`${BEGIN}[\\s\\S]*?${END}`);
if (!re.test(html)) {
  console.error('[whale] index.html 里找不到 WHALE:BEGIN/END 标记, 没动');
  process.exit(1);
}
const next = html.replace(re, block);
await fs.writeFile(HTML_FILE, next, 'utf8');
console.log(`[whale] 已内联鲸鱼娘 symbol (${block.length} 字节)`);
