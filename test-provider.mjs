/*
 * 第三方供应商兼容性验收。
 *
 * 起一个"故意很难伺候"的模拟 OpenAI 兼容服务，验证控制台能扛住：
 *   1. 只认 Bearer + 正确路径
 *   2. 收到 response_format 就返回 400（很多第三方/中转就是这样）
 *   3. JSON 外面包 ```json 围栏（模型常见毛病）
 *   4. 校验控制台真的把 Key 放在 Authorization: Bearer 里
 *   5. 验证 Base URL 粘成完整端点时能被自动剥掉后缀
 *
 * 用法: node test-provider.mjs [控制台端口]
 */
import http from 'node:http';

const CONSOLE_PORT = process.argv[2] || '8899';
const MOCK_PORT = 9911;
const GOOD_KEY = 'test-key-123';
const B = `http://127.0.0.1:${CONSOLE_PORT}`;

const results = [];
const ck = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

/* ---------- 模拟供应商 ---------- */

const seen = { requests: [] };

const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }

  const record = {
    method: req.method,
    url: req.url,
    auth: req.headers.authorization || '',
    apiKeyHeader: req.headers['api-key'] || '',
    xApiKey: req.headers['x-api-key'] || '',
    extra: { referer: req.headers['http-referer'] || '', title: req.headers['x-title'] || '' },
    hasResponseFormat: !!body.response_format,
    model: body.model,
  };
  seen.requests.push(record);

  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // 路径必须精确
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    return json(404, { error: { message: `no such route: ${req.method} ${req.url}` } });
  }
  // 鉴权必须对
  if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
    return json(401, { error: { message: 'invalid api key' } });
  }
  // 故意不支持 response_format —— 真实世界里一大批第三方都是这样
  if (body.response_format) {
    return json(400, {
      error: { message: 'Unsupported parameter: response_format is not supported by this provider' },
    });
  }

  const content = JSON.stringify({
    keywords: ['抽象整活', '下饭搞笑', '年轻人抽象'],
    contentSummary: '（模拟供应商返回）想要无厘头抽象搞笑的下饭视频',
    styleNotes: '语气软萌；句子要短',
  });

  // 故意包一层 ```json 围栏 —— 模型最常见的毛病
  return json(200, {
    id: 'mock-1',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content: '```json\n' + content + '\n```' }, finish_reason: 'stop' }],
  });
});

/* ---------- 驱动控制台 ---------- */

const get = (p) => fetch(B + p).then((r) => r.json());
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

async function setProvider({ baseUrl, model, key, authMode, endpoint, extraHeaders }) {
  return post('/api/settings', {
    ds: { baseUrl, model, apiKey: key, authMode, endpoint, extraHeaders },
  });
}

await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`模拟供应商已启动: http://127.0.0.1:${MOCK_PORT}/v1\n`);

try {
  /* 1) 存 full endpoint 形态的 baseUrl, 验证后缀被自动剥掉 */
  await setProvider({
    baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, // 故意粘成完整端点
    model: 'mock-model',
    key: GOOD_KEY,
    authMode: 'bearer',
    extraHeaders: 'HTTP-Referer: https://example.com\nX-Title: bili-studio',
  });

  let r = await post('/api/ds/test', {});
  ck('Base URL 粘成完整端点时能自动纠正', r.ok === true && r.endpoint === `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
    `endpoint=${r.endpoint} ok=${r.ok}${r.ok ? '' : ' err=' + r.error}`);
  ck('Key 以 Authorization: Bearer 发出', seen.requests.at(-1)?.auth === `Bearer ${GOOD_KEY}`,
    `实际收到: ${JSON.stringify(seen.requests.at(-1)?.auth)}`);
  ck('额外请求头被发送', seen.requests.at(-1)?.extra.referer === 'https://example.com'
    && seen.requests.at(-1)?.extra.title === 'bili-studio',
    JSON.stringify(seen.requests.at(-1)?.extra));

  /* 2) 分析偏好: 会触发 response_format 400 -> 去掉重试 -> 再解 ```json 围栏 */
  seen.requests.length = 0;
  const a = await post('/api/ds/analyze', {});
  const reqs = seen.requests.filter((x) => x.url === '/v1/chat/completions');
  ck('不支持 response_format 时自动去掉参数重试',
    reqs.length >= 2 && reqs[0].hasResponseFormat === true && reqs[1].hasResponseFormat === false,
    `请求次数=${reqs.length}, 首次带 response_format=${reqs[0]?.hasResponseFormat}, 重试时=${reqs[1]?.hasResponseFormat}`);
  ck('能解析被 ```json 围栏包住的回复',
    !a.error && Array.isArray(a.analysis?.keywords) && a.analysis.keywords.length === 3,
    a.error ? 'err=' + a.error : JSON.stringify(a.analysis?.keywords));

  /* 3) 鉴权方式 api-key（Azure 风格） */
  await setProvider({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model', key: GOOD_KEY, authMode: 'api-key' });
  seen.requests.length = 0;
  await post('/api/ds/test', {});
  ck('可切换成 api-key 请求头', seen.requests.at(-1)?.apiKeyHeader === GOOD_KEY,
    `api-key=${JSON.stringify(seen.requests.at(-1)?.apiKeyHeader)}`);

  /* 4) 错误 Key 时应给出可读的 401 提示 */
  await setProvider({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model', key: 'wrong-key', authMode: 'bearer' });
  r = await post('/api/ds/test', {});
  ck('错误 Key 时返回可读的 401 提示', r.ok === false && /401/.test(r.error || '') && /Key/.test(r.error || ''),
    (r.error || '').split('\n')[0]);

  /* 5) 完整端点覆盖（带查询串，Azure 那种） */
  await setProvider({
    baseUrl: 'https://ignored.example.com', model: 'mock-model', key: GOOD_KEY,
    authMode: 'bearer', endpoint: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions?api-version=2024-06-01`,
  });
  r = await post('/api/ds/test', {});
  // 模拟服务只认无查询串的路径, 所以这里预期是 404 + 我们的路径提示 —— 关键是验证"完整端点被原样使用"
  ck('完整端点被原样使用（不再拼接）',
    /api-version=2024-06-01/.test(r.endpoint || '') && r.ok === false,
    `endpoint=${r.endpoint}`);

  /* 6) 本地免鉴权服务（authMode=none）不该因为没 Key 而报错 */
  await setProvider({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model', key: '', authMode: 'none' });
  r = await post('/api/ds/test', {});
  ck('免鉴权模式不因缺 Key 而拒绝', !/没填 API Key/.test(r.error || ''),
    r.ok ? '连通' : (r.error || '').split('\n')[0]);
} finally {
  mock.close();
}

const bad = results.filter((x) => !x.ok);
console.log(`\n===== ${results.length - bad.length}/${results.length} 通过 =====`);
if (bad.length) {
  console.log('失败项:');
  bad.forEach((b) => console.log(' -', b.name, '|', b.detail));
}
process.exit(bad.length ? 1 : 0);
