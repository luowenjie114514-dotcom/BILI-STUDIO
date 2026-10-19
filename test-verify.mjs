/* 重启后验证: 关键词缓存 + 标题解码 + 干跑任务 */
const B = 'http://127.0.0.1:8787';
const get = (p) => fetch(B + p).then((r) => r.json());
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

(async () => {
  let s = await get('/api/state');
  console.log('账户:', s.accounts.map((a) => a.uname + '(Lv' + a.level + ')').join(', ') || '无');
  console.log('@名单:', s.mentions.map((m) => '@' + m.uname).join(' ') || '空');
  console.log('已缓存关键词:', JSON.stringify(s.keywords));
  console.log('干跑模式:', s.task.dryRun);

  // 再跑一次分析, 验证缓存写入 + 标题解码
  const a = await post('/api/ds/analyze', {});
  if (a.error) { console.log('分析失败:', a.error); return; }
  console.log('新关键词:', JSON.stringify(a.analysis.keywords));
  for (const p of a.preview) {
    const t = (p.top[0] || {}).title || '';
    console.log('  例:', t);
    console.log('     含HTML实体?', /&(quot|amp|lt|gt|#39|nbsp);/.test(t) ? '是(BUG)' : '否(ok)');
  }

  // 干跑任务: 验证用的是缓存关键词, 不再重复调分析
  const r = await post('/api/task/run', { repeat: 2, dryRun: true });
  console.log('干跑启动:', r.started ? 'yes' : JSON.stringify(r));
  for (let i = 0; i < 40; i++) {
    await new Promise((x) => setTimeout(x, 2000));
    const st = await get('/api/task/history');
    if (!st.running) {
      const h = st.history[0];
      console.log('结果:', JSON.stringify({ planned: h.planned, posted: h.posted, failed: h.failed, skipped: h.skipped }));
      for (const it of h.items) console.log('  -', it.bvid, it.status, '|', it.message);
      break;
    }
  }
})().catch((e) => console.log('异常:', e.message));
