/* 端到端测试: 偏好 -> DS 分析 -> 试搜 -> 预览 -> 干跑任务 */
const B = 'http://127.0.0.1:8787';
const post = (p, o) => fetch(B + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(o || {}),
}).then((r) => r.json());

(async () => {
  let r = await post('/api/settings', {
    contentPreference: '无厘头搞笑、抽象、面向年轻人的下饭消遣视频，播放量高、评论区活跃',
    stylePreference: '暖一点，像小鲸鱼撒娇，简短自然，不要书面语',
    signature: '笨蛋鲸鱼娘',
  });
  console.log('1) 保存偏好:', r.error ? 'FAIL ' + r.error : 'ok');

  r = await post('/api/ds/analyze', {});
  if (r.error) {
    console.log('2) DS 分析失败:', r.error);
  } else {
    console.log('2) DS 关键词:', JSON.stringify(r.analysis.keywords));
    console.log('   概括:', r.analysis.contentSummary);
    for (const p of r.preview) {
      console.log('   搜索「' + p.keyword + '」->',
        p.error ? 'ERR ' + p.error : p.count + ' 条, 例: ' + ((p.top[0] || {}).title || ''));
    }
  }

  r = await post('/api/preview', { text: '这条笑死我了' });
  console.log('3) 预览拼接:', r.message);

  r = await post('/api/task/run', { repeat: 2, dryRun: true });
  console.log('4) 干跑任务已启动:', r.started ? 'yes' : JSON.stringify(r));

  // 等任务跑完再看日志
  for (let i = 0; i < 40; i++) {
    await new Promise((s) => setTimeout(s, 2000));
    const st = await fetch(B + '/api/task/history').then((x) => x.json());
    if (!st.running) {
      const h = st.history[0];
      console.log('5) 任务结束:', JSON.stringify({
        planned: h.planned, posted: h.posted, failed: h.failed, skipped: h.skipped,
        ms: h.ms, error: h.error || null,
      }));
      for (const it of h.items) {
        console.log('   -', it.bvid, '|', it.status, '|', it.message);
      }
      break;
    }
  }
})().catch((e) => console.log('测试异常:', e.message));
