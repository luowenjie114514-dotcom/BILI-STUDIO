/*
 * 用真实供应商(opc.fiime.cn)驱动控制台, 验证：
 *   - 配置能被正确解析成完整端点
 *   - Key 以 Bearer 发出
 *   - 503 时会自动退避重试, 并把供应商原文呈现出来
 * key 从 DSH 凭据读取, 不硬编码、不打印明文。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.argv[2] || '8899';
const B = `http://127.0.0.1:${PORT}`;

const KEY = /^\s*OPCFIIME_API_KEY:\s*(\S+)\s*$/m
  .exec(fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8'))[1];

const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

const BASE_URL = 'https://opc.fiime.cn/api/model-service/v1';
const MODEL = process.argv[3] || 'deepseek-v4-flash';

console.log(`配置: baseUrl=${BASE_URL}  model=${MODEL}  key=${KEY.slice(0, 8)}***${KEY.slice(-6)}\n`);

const s = await post('/api/settings', {
  ds: { baseUrl: BASE_URL, model: MODEL, apiKey: KEY, authMode: 'bearer', endpoint: '', extraHeaders: '' },
});
console.log('保存设置:', s.error ? 'FAIL ' + s.error : `ok (model=${s.ds?.model}, baseUrl=${s.ds?.baseUrl})`);
console.log('Key 掩码:', s.ds?.apiKeyMask, '| 来源:', s.ds?.apiKeySource, '\n');

console.log('=== /api/ds/test ===');
const t0 = Date.now();
const t = await post('/api/ds/test', {});
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log('实际请求地址:', t.endpoint);
console.log('模型 / 鉴权 :', t.model, '/', t.authMode);
console.log('结果        :', t.ok ? `✔ 连通, 回复="${t.reply}"` : `✖ 失败\n${t.error}`);

console.log('\n=== /api/ds/analyze ===');
const t1 = Date.now();
const a = await post('/api/ds/analyze', {});
console.log(`耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
if (a.error) {
  console.log('✖ 失败:', a.error);
} else {
  console.log('✔ 关键词:', JSON.stringify(a.analysis.keywords));
  console.log('  概括  :', a.analysis.contentSummary);
  console.log('  试搜  :', (a.preview || []).map((p) => `${p.keyword}->${p.error ? 'ERR' : p.count + '条'}`).join(' | '));
}
