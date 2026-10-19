// 功能验证（干跑，绝不真发）: 私信模式「名单里能发的人都发一遍 + 绝不发给自己」
// 运行: node test-dm-skip.mjs [端口]
// 不写配置，只发一次 dryRun 请求，所以可以放心对主人的实例跑。
const BASE = 'http://127.0.0.1:' + (process.argv[2] || '8901') + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, body) => {
  const r = await fetch(BASE + p, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

const st = await fetch(BASE + 'api/state').then((x) => x.json());
const me = (st.accounts || []).find((a) => a.id === st.activeAccountId) || (st.accounts || [])[0] || {};

await j('api/logs/clear', {});
const t0 = Date.now();
const run = await j('api/task/run', { dm: true, dryRun: true, repeat: 1 });
console.log('触发:', JSON.stringify(run));
let running = true, logs = [];
while (running && Date.now() - t0 < 180000) {
  await sleep(1500);
  const r = await fetch(BASE + 'api/logs?since=0').then((x) => x.json());
  logs = r.logs; running = r.running;
}
for (const l of logs) console.log(`[${l.level}] ${l.message}`);

const text = logs.map((l) => l.message).join('\n');
const ok = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);

const cap = text.match(/私信模式: 可发 (\d+) 人, 本轮发 (\d+) 人/);
ok(/私信模式/.test(text), '走的是私信模式');
ok(!!cap, '打出「可发 N 人, 本轮发 M 人」');
if (cap) {
  ok(cap[1] === cap[2], `可发 ${cap[1]} 人 == 本轮发 ${cap[2]} 人（不再是只发第一个）`);
  ok(Number(cap[2]) >= 1, '本轮至少发 1 人');
}
// 自检: 自己绝不能出现在「→ @xxx (mid=...)」的收件人里
const selfHit = me.mid ? new RegExp(`→ @[^\\n]*\\(mid=${me.mid}\\)`).test(text) : false;
ok(!selfHit, `没有发给自己 (${me.uname || '?'}/${me.mid || '?'})`);
// 自己若在名单里，必须有一句「跳过」说明
const selfInList = (st.mentions || []).some((m) => m.enabled && String(m.mid) === String(me.mid));
if (selfInList) ok(/就是当前账户自己/.test(text), '自己也在名单里 → 有跳过日志');
else ok(true, '自己不在名单里 → 无需跳过（跳过）');
ok(/干跑模式/.test(text), '干跑模式下没有真发');
ok(/任务结束\(私信\)/.test(text), '任务正常收尾');
