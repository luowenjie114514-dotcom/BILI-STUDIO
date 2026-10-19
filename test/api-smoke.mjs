/**
 * 接口冒烟测试。
 *
 * 不依赖 B 站 cookie、不依赖 AI 供应商 —— 只验证「服务起来了、路由在、返回结构对」。
 * 这样在断网/没 key/没登录的环境里也能确认代码没被改坏。
 *
 * 约定: BASE 环境变量或 --port= 指定地址; exit 0 = 通过。
 */

const argvPort = process.argv.find((a) => a.startsWith('--port='));
const BASE = process.env.BASE
  || (argvPort ? `http://127.0.0.1:${argvPort.slice(7)}` : `http://127.0.0.1:${process.argv[2] || '8899'}`);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

async function req(pathname, opts = {}) {
  const r = await fetch(BASE + pathname, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeout || 30_000),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  return { status: r.status, json, text };
}

const post = (p, body, timeout) => req(p, { method: 'POST', body: JSON.stringify(body ?? {}), timeout });

console.log('api-smoke @ ' + BASE);

console.log('--- 1. 基础状态 ---');
const st = await req('/api/state');
ok('GET /api/state 200', st.status === 200, st.status);
ok('返回 version', typeof st.json?.version === 'string' && st.json.version.length > 0, st.json?.version);
ok('返回 configVersion.current', Number.isInteger(st.json?.configVersion?.current), st.json?.configVersion);
ok('accounts 是数组', Array.isArray(st.json?.accounts), typeof st.json?.accounts);
ok('task 是对象', st.json?.task && typeof st.json.task === 'object');
ok('ds.apiKey 永远为空(不泄漏)', st.json?.ds?.apiKey === '', st.json?.ds?.apiKey);
ok('accounts 里没有明文 sessdata', (st.json?.accounts || []).every((a) => !a.sessdata || a.sessdata.includes('***')),
  (st.json?.accounts || []).map((a) => a.sessdata));

console.log('--- 2. 更新日志 ---');
const cl = await req('/api/changelog');
ok('GET /api/changelog 200', cl.status === 200, cl.status);
ok('带版本号', typeof cl.json?.version === 'string');
ok('正文非空', typeof cl.json?.text === 'string' && cl.json.text.length > 50, cl.json?.text?.length);

console.log('--- 3. 消息预览(纯拼装, 不调 AI) ---');
{
  const p = await post('/api/preview', { dm: false });
  ok('POST /api/preview 200', p.status === 200, p.status);
  ok('返回 message', typeof p.json?.message === 'string' && p.json.message.length > 0);
  ok('返回 chars 数字', Number.isInteger(p.json?.chars), p.json?.chars);
  // 评论区没有字数上限, charsLimit 就该是 null —— 只有私信才有上限
  ok('评论态 charsLimit 为 null', p.json?.charsLimit === null, p.json?.charsLimit);
}
{
  const p = await post('/api/preview', { dm: true, title: true });
  ok('私信预览 200', p.status === 200, p.status);
  ok('私信 form 合法', ['card', 'texturl'].includes(p.json?.form), p.json?.form);
  ok('私信态 charsLimit 是正数', Number.isInteger(p.json?.charsLimit) && p.json.charsLimit > 0, p.json?.charsLimit);
  ok('私信 chars 不超过上限', p.json?.chars <= p.json?.charsLimit,
    { c: p.json?.chars, l: p.json?.charsLimit });
}

console.log('--- 4. 账户健康检查(不要求已登录) ---');
{
  const h = await post('/api/accounts/health', {}, 90_000);
  ok('POST /api/accounts/health 200', h.status === 200, h.status);
  ok('返回 accounts 数组', Array.isArray(h.json?.accounts), typeof h.json?.accounts);
  ok('每项有 ok 布尔值', (h.json?.accounts || []).every((a) => typeof a.ok === 'boolean'),
    (h.json?.accounts || []).map((a) => typeof a.ok));
}

console.log('--- 5. 定时任务列表 ---');
{
  const s = await post('/api/schedules', {}, 30_000);
  // 这个接口可能要求参数, 500 也算「路由存在」; 只验证不是 404
  ok('POST /api/schedules 不是 404', s.status !== 404, s.status);
}

console.log('--- 6. 终端接口 ---');
{
  const t = await req('/api/term?since=0');
  ok('GET /api/term 200', t.status === 200, t.status);
  ok('返回 lines 数组', Array.isArray(t.json?.lines), typeof t.json?.lines);
  ok('返回 seq 数字', Number.isInteger(t.json?.seq), t.json?.seq);
  ok('返回 running 布尔', typeof t.json?.running === 'boolean', t.json?.running);
  const e = await post('/api/term/exec', { cmd: 'echo smoke-test-ok' }, 30_000);
  ok('POST /api/term/exec 有响应', e.status === 200 || e.status === 500, e.status);
  await new Promise((r) => setTimeout(r, 1200));
  const t2 = await req('/api/term?since=0');
  const joined = (t2.json?.lines || []).map((l) => (typeof l === 'string' ? l : l.text || '')).join('\n');
  ok('终端里能看到刚才那条命令的输出', joined.includes('smoke-test-ok'),
    joined.slice(-200));
}

console.log('--- 7. 未知路由返回 404 ---');
{
  const u = await req('/api/definitely-not-a-route');
  ok('未知 API 是 404', u.status === 404, u.status);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
