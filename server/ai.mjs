/**
 * AI 层(v1.6.0 从 server.mjs 抽出)
 * ------------------------------------------------------------------
 * 负责跟「OpenAI 兼容」的接口说话：拼请求、重试、剥 JSON、翻译错误。
 * 不直接读 config —— 由 server.mjs 通过 setAiContext({...}) 注入,
 * 这样这一层单测时能喂假配置、假 key。
 */

import { sleep } from './util.mjs';

let ctx = {
  getDs: () => ({}),
  getKey: () => '',
  log: () => {},
};

/** server.mjs 启动时注入配置读取器和日志函数 */
export function setAiContext(next = {}) {
  if (typeof next.getDs === 'function') ctx.getDs = next.getDs;
  if (typeof next.getKey === 'function') ctx.getKey = next.getKey;
  if (typeof next.log === 'function') ctx.log = next.log;
}

export function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\s+/g, '');
  if (!u) u = 'https://api.deepseek.com';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '');
  u = u.replace(/\/+$/, '');
  return u;
}

/** 解析出最终请求地址和请求头（含鉴权方式与额外头部） */
export function resolveAiRequest() {
  const ds = ctx.getDs() || {};
  const key = ctx.getKey();

  // 1) 地址：填了"完整端点"就用它（支持带 ?api-version= 这种查询串，比如 Azure）
  const override = String(ds.endpoint || '').trim();
  const url = override || `${normalizeBaseUrl(ds.baseUrl)}/chat/completions`;

  // 2) 鉴权：默认 Bearer；Azure 用 api-key；本地服务(none)不需要 key
  const mode = ds.authMode || 'bearer';
  const headers = { 'Content-Type': 'application/json' };
  if (mode === 'bearer') headers.Authorization = `Bearer ${key}`;
  else if (mode === 'api-key') headers['api-key'] = key;
  else if (mode === 'x-api-key') headers['x-api-key'] = key;
  // mode === 'none' -> 不加鉴权头

  // 3) 额外请求头：每行 "Name: value"（OpenRouter 的 HTTP-Referer 之类）
  for (const line of String(ds.extraHeaders || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9\-_.]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) headers[m[1]] = m[2];
  }

  return { url, headers, authMode: mode };
}

/** 从错误响应体里尽量抠出人话（很多供应商把原因放在 error.message） */
export function extractErrMessage(text) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.error?.code || j?.message;
    if (m) return String(m).slice(0, 200);
  } catch { /* 不是 JSON */ }
  return String(text || '').replace(/\s+/g, ' ').slice(0, 200);
}

/** 把 HTTP 错误翻译成主人看得懂的提示 */
export function describeAiError(status, text, url) {
  const reason = extractErrMessage(text);
  let hint = '';
  if (status === 401 || status === 403) hint = 'Key 无效 / 没权限（确认用的是 Bearer，且 Key 没写错）';
  else if (status === 404) hint = `路径不对，实际请求的是 ${url} —— 常见原因是 Base URL 少了 /v1，或该供应商路径不同（可改用「完整端点」直接填）`;
  else if (status === 429) hint = '触发限流或余额不足';
  else if (status === 400) hint = '请求被拒（模型名不对，或该接口不支持某个参数）';
  else if (status === 503) hint = '供应商服务繁忙/过载（已自动重试过，稍后再试即可）';
  else if (status >= 500) hint = '供应商服务端错误（已自动重试过）';
  return `HTTP ${status}${hint ? ` — ${hint}` : ''}${reason ? `\n供应商原文：${reason}` : ''}`;
}

/** 从模型回复里抠出 JSON：先剥 ```json 围栏，再取第一个 { 到最后一个 } */
export function extractJsonObject(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/**
 * 记住这家供应商不支持 response_format, 之后直接跳过, 省一次 400 往返。
 * 用对象包一层: 打包成 CJS 后 export let 是快照值, 外部读不到后续修改。
 */
export const aiState = { jsonModeUnsupported: false };

export async function dsChat(messages, { json = false, temperature = 0.9 } = {}) {
  const ds = ctx.getDs() || {};
  const key = ctx.getKey();
  const { model } = ds;
  const { url, headers, authMode } = resolveAiRequest();
  if (authMode !== 'none' && !key) {
    throw new Error('没填 API Key（免鉴权的本地服务请把「鉴权方式」改成 none）');
  }

  const baseBody = { model, messages, temperature };
  const wantJson = json && !aiState.jsonModeUnsupported;

  // 限流 / 过载 / 网关错误都是"等一下就好"，不该直接废掉整轮任务，
  // 所以这里做短退避重试（2s、4s）。
  const RETRYABLE = new Set([429, 500, 502, 503, 504]);
  const MAX_TRIES = 3;
  const send = async (body) => {
    let last = null;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      const text = await res.text();
      last = { res, text };
      if (res.ok || !RETRYABLE.has(res.status) || attempt === MAX_TRIES) return last;
      const wait = attempt * 2;
      ctx.log('warn', `接口返回 ${res.status}（${extractErrMessage(text)}），${wait} 秒后重试（${attempt}/${MAX_TRIES}）`);
      await sleep(wait * 1000);
    }
    return last;
  };

  let { res, text } = await send(wantJson ? { ...baseBody, response_format: { type: 'json_object' } } : baseBody);

  // 兼容性兜底：json 模式比普通模式只多一个 response_format 参数。
  // 所以只要 json 模式下吃到 400，就高度可疑是该参数不被支持 —— 直接去掉重试。
  //
  // 这里刻意【不】匹配错误文案：各家措辞差别太大，
  // 比如 opc.fiime.cn 返回的是中文「请求参数不被当前模型支持」，
  // 早期版本按英文关键词匹配, 结果兜底根本没触发。
  if (!res.ok && wantJson && res.status === 400) {
    const why = extractErrMessage(text);
    ctx.log('warn', `json 模式被拒（${why}），去掉 response_format 重试一次`);
    ({ res, text } = await send(baseBody));
    if (res.ok) {
      aiState.jsonModeUnsupported = true;
      ctx.log('info', '已记住：该供应商不支持 response_format，后续调用将跳过该参数');
    }
  }

  if (!res.ok) throw new Error(describeAiError(res.status, text, url));

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`接口返回的不是 JSON：${String(text).slice(0, 200)}`);
  }

  const msg = parsed?.choices?.[0]?.message?.content;
  // 有些供应商多模态时 content 是数组，这里拼回纯文本
  const content = Array.isArray(msg)
    ? msg.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('')
    : msg;
  if (typeof content !== 'string' || !content.trim()) {
    const errField = parsed?.error ? JSON.stringify(parsed.error).slice(0, 200) : String(text).slice(0, 200);
    throw new Error(`接口没有返回内容：${errField}`);
  }
  return content;
}
