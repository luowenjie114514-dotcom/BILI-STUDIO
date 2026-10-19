// v1.5.1 验收: 私信正文是不是「转述」而不是「扭捏作态」, 字数是不是真的卡住
const BASE = process.argv.find((a) => a.startsWith('--port=')) ? `http://127.0.0.1:${process.argv.find((a) => a.startsWith('--port=')).slice(7)}/` : 'http://127.0.0.1:8899/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, o) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}) }).then((r) => r.json());

let fails = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++; };

// 0) 兜底: 字数函数本身
const clip = await post('api/preview', {
  dm: true, text: '这是插件发布视频，他说判据还在改，我觉得鱼太多就别发了，而且评论区一大半都是别的AI在扮演鱼，有报到的有总结视频的还有自称大肥鱼来推广的，UP 一条条在回。',
});
console.log('  preview:', JSON.stringify({ chars: clip.chars, limit: clip.charsLimit, msg: clip.message }));
ok(clip.charsLimit === 40, `预览返回字数上限 40 (${clip.charsLimit})`);
ok(clip.chars <= 40, `预览正文被截到 ${clip.chars} 字`);
ok(!/^\s*@/m.test(clip.message), '私信不含 @ 昵称');

// 1) 真实干跑: 让 DS 写一条
const before = await get('api/state');
const r = await post('api/task/run', { dm: true, dryRun: true, repeat: 1 });
console.log('  run:', JSON.stringify(r).slice(0, 300));
await sleep(1500);

// 2) 从日志里把 DS 写出来的正文捞出来看
const logs = await get('api/logs?since=0');
const lines = (logs.lines || []).map((l) => l.text || l.msg || '');
const gen = lines.filter((t) => t.includes('DS 生成私信'));
const cnt = lines.filter((t) => t.includes('正文字数'));
const bump = lines.filter((t) => t.includes('超过上限'));
console.log('  生成条数:', gen.length, ' 字数行:', cnt.length, ' 截断行:', bump.length);
for (const g of gen) {
  const body = g.replace(/^.*DS 生成私信:\s*/, '').trim();
  console.log('  >>>', body, `  [${[...body.replace(/\s+/g, '')].length} 字]`);
  ok([...body.replace(/\s+/g, '')].length <= 40, '正文不超过 40 字');
  ok(!/你也太懂我|心里复杂|太会了|笑死我了/.test(body), '没有表演情绪的套话');
  ok(!/^\s*@/.test(body), '正文里没有 @ 昵称');
}
for (const c of cnt) console.log('  字数:', c.replace(/^.*\]\s*/, ''));
for (const b of bump) console.log('  截断:', b.replace(/^.*\]\s*/, ''));

console.log(fails ? `\n❌ ${fails} 项失败` : '\n✅ 全部通过');
process.exit(fails ? 1 : 0);
