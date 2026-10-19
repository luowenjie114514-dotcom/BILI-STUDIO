/**
 * B 站 API 层(v1.6.0 从 server.mjs 抽出)
 * ------------------------------------------------------------------
 * 只跟 B 站打交道: 拼 cookie / 发请求 / 解析返回。
 * 不读 config、不写日志、不管任务编排 —— 那些是上层的事。
 *
 * 对外需要 UA: 由调用方通过 configureBili({ UA }) 注进来,
 * 这样这一层完全不依赖 server.mjs 里的常量。
 */

// 注意: 打包时所有模块会被内联进同一个作用域(build.mjs 的 inlineModules),
// 所以跨模块同名符号必须起别名, 否则 CJS bundle 里会 "already been declared"。
import { decodeEntities as decodeHtmlEntities } from './util.mjs';

let UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

/** server.mjs 启动时把真正的 UA 传进来 */
export function configureBili(opts = {}) {
  if (opts.UA) UA = opts.UA;
}

export async function reqJSON(url, { method = 'GET', form, headers = {}, cookie, timeout = 25000 } = {}) {
  const h = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...headers };
  if (cookie) h.Cookie = cookie;
  const init = { method, headers: h, signal: AbortSignal.timeout(timeout) };
  if (form) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, init);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

/** 请求头里所有需要/值得认的字段, 大小写不敏感 */
export const COOKIE_KEYS = [
  'SESSDATA', 'bili_jct', 'buvid3', 'buvid4', 'buvid_fp', 'DedeUserID',
  'DedeUserID__ckMd5', 'b_nut', '_uuid', 'bili_ticket', 'sid', 'rpdid',
];

/**
 * 从"整串"(cookie 串 或 完整请求头文本)里精准抠出目标字段。
 *
 * 支持的输入形态:
 *   - 纯 cookie:  SESSDATA=xxx; bili_jct=yyy; buvid3=zzz
 *   - 请求头原文: Cookie: SESSDATA=xxx; ...\nUser-Agent: ...\nReferer: ...
 *   - 复制表格:   SESSDATA   xxx
 *   - 带引号:     SESSDATA="xxx"
 *
 * 说明: 用 `名=[值]` 做整体匹配, 值到 `;` / 空白 / 换行 / 引号 为止。
 * SESSDATA 常见 `%2C` 等百分号编码, 这里保持原样(原样回传 B 站才对),
 * 只对误包进值的末尾标点做一次清理。
 */
export function parseCredentialText(raw) {
  const text = String(raw || '');
  const out = { found: [] };
  for (const key of COOKIE_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 边界: 行首/分号/空白/换行 + 字段名 + 可选冒号或等号 + 可选引号 + 值(到 分号/换行/结尾 为止)
    const re = new RegExp('(^|[\\s;"\\n])' + escaped + '\\s*[:=]\\s*"?(.*?)(?:"?\\s*(?:;|\\r?\\n|$))', 'i');
    const m = re.exec(text);
    if (m && m[2] !== undefined) {
      let val = m[2].trim();
      // 去掉误吞的尾部标点(逗号/分号/引号), 但保留中间的 %2C 这类编码
      val = val.replace(/[;"']+$/, '');
      if (val) {
        const storeKey = key === 'DedeUserID__ckMd5' ? 'dedeUserIdCkMd5' : key;
        out[storeKey] = val;
        out.found.push(key);
      }
    }
  }
  return out;
}

export function biliCookie(acc, withJct = false) {
  if (!acc) return '';
  const parts = [];
  if (acc.sessdata) parts.push(`SESSDATA=${acc.sessdata}`);
  if (withJct && acc.biliJct) parts.push(`bili_jct=${acc.biliJct}`);
  if (acc.buvid3) parts.push(`buvid3=${acc.buvid3}`);
  if (acc.dedeUserId) parts.push(`DedeUserID=${acc.dedeUserId}`);
  return parts.join('; ');
}

export async function biliNav(acc) {
  const r = await reqJSON('https://api.bilibili.com/x/web-interface/nav', {
    cookie: biliCookie(acc, false),
  });
  const d = r.data || {};
  return {
    ok: r.code === 0 && d.isLogin === true,
    code: r.code,
    message: r.message,
    uname: d.uname || '',
    // mid 统一成字符串: 接口返回的是数字, 而 @名单 里存的是字符串,
    // 混用会让 === 比较和去重判断失效
    mid: d.mid ? String(d.mid) : '',
    level: (d.level_info || {}).current_level ?? null,
  };
}

export async function biliUserSearch(keyword, acc) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type?'
    + new URLSearchParams({ search_type: 'bili_user', keyword, page: 1 });
  const r = await reqJSON(url, {
    headers: { Referer: 'https://search.bilibili.com/' },
    cookie: acc ? biliCookie(acc) : '',
  });
  if (r.code !== 0) throw new Error(`用户搜索失败: ${r.code} ${r.message}`);
  return ((r.data || {}).result || []).map((u) => ({
    mid: String(u.mid), uname: u.uname, fans: u.fans, sign: u.usign || '',
  }));
}

export async function biliVideoSearch(keyword, page, acc) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type?'
    + new URLSearchParams({
      search_type: 'video', keyword, page: String(page || 1),
    });
  const r = await reqJSON(url, {
    headers: { Referer: `https://search.bilibili.com/video?keyword=${encodeURIComponent(keyword)}` },
    cookie: acc ? biliCookie(acc) : '',
  });
  if (r.code !== 0) throw new Error(`视频搜索失败: ${r.code} ${r.message}`);
  return ((r.data || {}).result || [])
    .filter((v) => v.bvid)
    .map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: decodeHtmlEntities(v.title),
      author: decodeHtmlEntities(v.author),
      mid: String(v.mid || ''),
      play: v.play || 0,
      danmaku: v.video_review || 0,
      duration: v.duration || '',
      pubdate: v.pubdate || 0,
      description: decodeHtmlEntities(v.description),
      pic: normalizePic(v.pic),
    }));
}

/** 搜索接口给的封面是 `//i0.hdslb.com/...`, 私信卡片里必须是完整 URL */
export function normalizePic(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (s.startsWith('http://')) return `https://${s.slice(7)}`;
  return s;
}

export async function biliVideoInfo(bvid, acc) {
  const r = await reqJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { Referer: `https://www.bilibili.com/video/${bvid}` },
    cookie: acc ? biliCookie(acc) : '',
  });
  if (r.code !== 0) throw new Error(`取稿件失败 ${bvid}: ${r.code} ${r.message}`);
  const d = r.data;
  return {
    bvid, aid: d.aid, cid: d.cid, title: d.title, author: d.owner.name,
    mid: String(d.owner.mid), desc: d.desc || '',
    play: d.stat.view, danmaku: d.stat.danmaku, reply: d.stat.reply,
    like: d.stat.like, coin: d.stat.coin, favorite: d.stat.favorite,
    pubdate: d.pubdate, tname: d.tname || '', pic: normalizePic(d.pic),
  };
}

export async function biliPostComment({ acc, aid, message }) {
  if (!acc?.sessdata || !acc?.biliJct) {
    throw new Error('账户缺少 SESSDATA 或 bili_jct, 无法发言');
  }
  const r = await reqJSON('https://api.bilibili.com/x/v2/reply/add', {
    method: 'POST',
    form: { type: 1, oid: aid, message, plat: 1, csrf: acc.biliJct },
    cookie: biliCookie(acc, true),
    headers: { Origin: 'https://www.bilibili.com', Referer: 'https://www.bilibili.com/' },
  });
  return r;
}

export const REPLY_ERRORS = {
  '-101': '账号未登录: cookie 失效了',
  '-111': 'csrf 校验失败: bili_jct 与 SESSDATA 不匹配',
  '-107': '账号未转正: Lv0 没有评论权限, 先去答题',
  12002: '评论区已关闭',
  12015: '需要验证码: 先手动在网页发一条',
  12016: '内容含敏感词',
  12035: '被 UP 主拉黑',
  12051: '重复评论, 换一句',
  12052: '评论区已关闭',
};
