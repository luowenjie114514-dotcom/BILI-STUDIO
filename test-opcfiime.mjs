/*
 * 探针: 直接测 opc.fiime.cn 端点, 确认鉴权方式、模型可用性、是否支持 response_format。
 * key 从 ~/.dsh/.credentials.yaml 的 OPCFIIME_API_KEY 读取, 不硬编码、不打印。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CRED = path.join(os.homedir(), '.dsh', '.credentials.yaml');
const txt = fs.readFileSync(CRED, 'utf8');
const m = /^\s*OPCFIIME_API_KEY:\s*(\S+)\s*$/m.exec(txt);
if (!m) { console.error('凭据里没找到 OPCFIIME_API_KEY'); process.exit(1); }
const KEY = m[1];
const masked = `${KEY.slice(0, 8)}***${KEY.slice(-6)}`;

const BASE = 'https://opc.fiime.cn/api/model-service/v1';
const URL_ = `${BASE}/chat/completions`;

async function probe(label, { model, extra = {}, headers = {}, url = URL_, method = 'POST', body }) {
  const h = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${KEY}`,
    ...headers,
  };
  try {
    const res = await fetch(url, {
      method,
      headers: h,
      body: method === 'POST' ? JSON.stringify(body ?? { model, messages: [{ role: 'user', content: '只回复两个字: 在线' }], ...extra }) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    const text = await res.text();
    let ok = res.ok;
    let brief = text.slice(0, 400);
    try {
      const j = JSON.parse(text);
      const c = j?.choices?.[0]?.message?.content;
      if (c) brief = `content=${JSON.stringify(String(c).slice(0, 120))}`;
      else if (j?.error) brief = `error=${JSON.stringify(j.error).slice(0, 250)}`;
      else brief = JSON.stringify(j).slice(0, 250);
    } catch { /* 保留原文 */ }
    console.log(`${ok ? '✔' : '✖'} ${label}\n    HTTP ${res.status} | ${brief}\n`);
    return { ok, status: res.status, text };
  } catch (e) {
    console.log(`✖ ${label}\n    网络异常: ${e.message}\n`);
    return { ok: false, error: e.message };
  }
}

console.log(`Key: ${masked}`);
console.log(`端点: ${URL_}\n`);

// 1) 两个模型分别探活
for (const model of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
  await probe(`Bearer 鉴权 + 模型 ${model}`, { model });
}

// 2) 是否支持 response_format（很多第三方不支持，控制台会自动回退）
await probe('带 response_format: json_object', {
  model: 'deepseek-v4-flash',
  extra: { response_format: { type: 'json_object' } },
});

// 3) 是否支持 /models 列表
await probe('GET /models（可选能力）', { method: 'GET', url: `${BASE}/models` });

// 4) 错误的 key 应该明确报 401（验证鉴权确实生效）
{
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-key' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    signal: AbortSignal.timeout(30000),
  }).catch((e) => ({ status: 'ERR', text: async () => e.message }));
  const t = await res.text();
  console.log(`${res.status === 401 ? '✔' : '?'} 错误 Key 的返回: HTTP ${res.status} | ${String(t).slice(0, 160)}\n`);
}
