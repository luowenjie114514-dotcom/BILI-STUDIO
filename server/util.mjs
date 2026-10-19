/**
 * 纯工具层: 不碰网络、不碰配置、不碰全局状态。
 * 全是可以在 REPL 里单测的纯函数。
 * v1.6.0 从 server.mjs 抽出, 函数体逐字照搬, 不改行为。
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从任意输入里抠 B 站 BV 号 */
export const BV_RE = /(BV[0-9A-Za-z]{10})/i;

/** 搜索接口返回的标题带 <em> 高亮和 HTML 实体, 这里还原成纯文本 */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;|&lsquo;|&rsquo;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

export function parseBvid(input) {
  const m = BV_RE.exec(String(input || ''));
  return m ? m[1] : null;
}

export function countChars(s) {
  return [...String(s || '').replace(/\s+/g, '')].length;
}

// 按字数截断, 尽量收在一个完整分句上, 实在不行就硬切
// 返回 { text, clipped }, 调用方靠 clipped 决定要不要打日志
export function clipChars(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  const arr = [...t];
  if (arr.length <= max) return { text: t, clipped: false };
  const head = arr.slice(0, Math.max(1, max)).join('');
  const cut = Math.max(
    head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'),
    head.lastIndexOf('；'), head.lastIndexOf('，'), head.lastIndexOf(','),
  );
  // 分句在最后 40% 之外就别切了, 不然会剩一截没意思的
  if (cut >= Math.floor(max * 0.6)) return { text: head.slice(0, cut).trim(), clipped: true };
  return { text: head.replace(/[，,、；;：:\s]+$/, '').trim(), clipped: true };
}

export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (base === null || typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = Object.prototype.hasOwnProperty.call(base, k) ? deepMerge(base[k], v) : v;
  }
  return out;
}
