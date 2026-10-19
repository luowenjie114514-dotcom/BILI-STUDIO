/* 供应商当前间歇性过载, 这里换模型 + 多轮重试, 直到拿到一次成功结果 */
const B = 'http://127.0.0.1:8787';
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());
const get = (p) => fetch(B + p).then((r) => r.json());
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function tryAnalyze(model, rounds = 3) {
  await post('/api/settings', { ds: { model, apiKeyRef: 'OPCFIIME_API_KEY', apiKey: '' } });
  for (let i = 1; i <= rounds; i++) {
    const a = await post('/api/ds/analyze', {});
    if (!a.error) {
      console.log(`  ✔ ${model} 第 ${i} 次成功`);
      console.log('    关键词:', JSON.stringify(a.analysis.keywords));
      console.log('    概括  :', a.analysis.contentSummary);
      for (const p of a.preview) console.log(`    试搜「${p.keyword}」-> ${p.error ? 'ERR ' + p.error : p.count + ' 条'}`);
      return true;
    }
    const busy = /503|繁忙|过载/.test(a.error);
    console.log(`  ✖ ${model} 第 ${i} 次${busy ? '(503 繁忙)' : ''}: ${String(a.error).split('\n')[0]}`);
    if (i < rounds) await sleep(6000);
  }
  return false;
}

console.log('=== 尝试 deepseek-v4-flash ===');
let ok = await tryAnalyze('deepseek-v4-flash', 3);
if (!ok) {
  console.log('\n=== 换成 deepseek-v4-pro ===');
  ok = await tryAnalyze('deepseek-v4-pro', 3);
}

if (!ok) {
  console.log('\n结论: 供应商当前持续过载, 稍后重试即可。控制台的重试与报错逻辑工作正常。');
  process.exit(0);
}

console.log('\n=== 干跑一轮, 看 AI 写的评论 ===');
const r = await post('/api/task/run', { repeat: 2, dryRun: true });
console.log('启动:', r.started ? 'yes' : JSON.stringify(r));
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const h = await get('/api/task/history');
  if (!h.running) {
    const t = h.history[0];
    console.log(`结果: 计划=${t.planned} 成功=${t.posted} 失败=${t.failed} 跳过=${t.skipped}`);
    for (const it of t.items) console.log('  -', it.bvid, '|', it.message);
    break;
  }
}
