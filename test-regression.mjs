/* 回归测试: analysis 从 null 变对象后, 重启能否正确加载配置
   —— 这正是 1.1.0 修掉的那个 deepMerge 崩溃场景 */
const B = 'http://127.0.0.1:8899';
const get = (p) => fetch(B + p).then((r) => r.json());
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

const before = await get('/api/state');
console.log('重启前: 账户=%d @名单=%d analysis=%s',
  before.accounts.length, before.mentions.length, before.analysis ? '有' : '无');

const a = await post('/api/ds/analyze', {});
if (a.error) { console.log('DS 分析失败(不影响结论):', a.error); }
else console.log('DS 分析成功, 关键词:', JSON.stringify(a.analysis.keywords));

const mid = await get('/api/state');
console.log('分析后: analysis=%s 关键词=%d 个',
  mid.analysis ? '有' : '无', (mid.keywords || []).length);
console.log('EXPECT_AFTER_ANALYZE accounts=%d mentions=%d', mid.accounts.length, mid.mentions.length);
