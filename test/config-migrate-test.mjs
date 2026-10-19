/**
 * 配置迁移链单测。
 * 跑法: node test/config-migrate-test.mjs
 */
import { SCHEMA_VERSION, MIGRATIONS, migrateConfigChain } from '../server/configmigrate.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

console.log('config-migrate');
console.log('--- 1. 版本常量与链完整性 ---');
ok('SCHEMA_VERSION 是正整数', Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION > 0, SCHEMA_VERSION);
ok('迁移链覆盖到当前版本', MIGRATIONS.some((m) => m.to === SCHEMA_VERSION), MIGRATIONS.map((m) => m.to));
ok('迁移版本号递增且无重复',
  MIGRATIONS.every((m, i) => i === 0 || m.to > MIGRATIONS[i - 1].to),
  MIGRATIONS.map((m) => m.to));
ok('每条迁移都有 run 函数', MIGRATIONS.every((m) => typeof m.run === 'function'));

console.log('--- 2. 老文件(无 schemaVersion)自动升级 ---');
{
  const raw = { accounts: [{ mid: 343791546, name: 'a' }], mentions: [{ mid: 1311761450 }], task: {} };
  const r = migrateConfigChain(raw, { log: () => {} });
  ok('v0 -> 当前版本', r.from === 0 && r.to === SCHEMA_VERSION, { from: r.from, to: r.to });
  ok('写入了 schemaVersion', raw.schemaVersion === SCHEMA_VERSION, raw.schemaVersion);
  ok('accounts.mid 变成字符串', raw.accounts[0].mid === '343791546', raw.accounts[0].mid);
  ok('mentions.mid 变成字符串', raw.mentions[0].mid === '1311761450', raw.mentions[0].mid);
  ok('task.dmMaxChars 补了 40', raw.task.dmMaxChars === 40, raw.task.dmMaxChars);
  ok('task.dmForm 补了 card', raw.task.dmForm === 'card', raw.task.dmForm);
  ok('返回了执行过的步骤', r.applied.length >= 1, r.applied);
}

console.log('--- 3. 已经是当前版本 -> 不再跑迁移 ---');
{
  const raw = { schemaVersion: SCHEMA_VERSION, task: {} };
  const r = migrateConfigChain(raw, { log: () => {} });
  ok('from == to', r.from === SCHEMA_VERSION && r.to === SCHEMA_VERSION, { from: r.from, to: r.to });
  ok('没有执行任何步骤', r.applied.length === 0, r.applied);
}

console.log('--- 4. 未来版本(用户降级)不被破坏 ---');
{
  const raw = { schemaVersion: SCHEMA_VERSION + 5, keepMe: 1 };
  const r = migrateConfigChain(raw, { log: () => {} });
  ok('不会倒退版本号', raw.schemaVersion === SCHEMA_VERSION, raw.schemaVersion);
  ok('未知字段原样保留', raw.keepMe === 1, raw.keepMe);
  ok('没有跑迁移', r.applied.length === 0);
}

console.log('--- 5. 坏输入不炸 ---');
{
  for (const bad of [null, undefined, 42, 'str', []]) {
    const r = migrateConfigChain(bad, { log: () => {} });
    ok(`坏输入 ${JSON.stringify(bad)} 不抛异常`, r && typeof r === 'object');
  }
}

console.log('--- 6. 单步迁移抛错时, 其余配置保住 ---');
{
  const saved = MIGRATIONS[0].run;
  MIGRATIONS[0].run = () => { throw new Error('故意炸'); };
  const raw = { schemaVersion: 0, signature: '笨蛋鲸鱼娘' };
  let threw = false;
  let r;
  try { r = migrateConfigChain(raw, { log: () => {} }); } catch { threw = true; }
  MIGRATIONS[0].run = saved;
  ok('没有把异常抛给调用方', threw === false);
  ok('配置对象还在', r && raw.signature === '笨蛋鲸鱼娘', raw.signature);
  ok('版本号仍然推进(避免每次启动重跑)', raw.schemaVersion === SCHEMA_VERSION, raw.schemaVersion);
}

console.log('--- 7. 用户数据不被迁移覆盖 ---');
{
  const raw = {
    schemaVersion: 0,
    signature: '自定义署名',
    task: { dmMaxChars: 88, dryRun: false },
  };
  migrateConfigChain(raw, { log: () => {} });
  ok('已有的 dmMaxChars 不被改成默认值', raw.task.dmMaxChars === 88, raw.task.dmMaxChars);
  ok('dryRun=false 保持', raw.task.dryRun === false, raw.task.dryRun);
  ok('签名保持', raw.signature === '自定义署名', raw.signature);
}

console.log('--- 8. 回归: DEFAULT_CONFIG 已填好版本号时, 仍按磁盘版本迁移 ---');
{
  // 真实故障场景: loadConfig 先 deepMerge(DEFAULT_CONFIG, raw), 而 DEFAULT_CONFIG
  // 自己带 schemaVersion。合并后 cfg.schemaVersion 已经是当前版本, 若迁移链读它,
  // 就会以为「不用迁移」而整条跳过 —— mid 永远转不成字符串。
  const merged = { schemaVersion: SCHEMA_VERSION, accounts: [{ mid: 343791546 }], task: {} };
  const r = migrateConfigChain(merged, { log: () => {}, fromVersion: 0 });
  ok('显式 fromVersion=0 时迁移照跑', r.applied.length >= 1, r.applied);
  ok('mid 被转成字符串(而不是数字)', typeof merged.accounts[0].mid === 'string', typeof merged.accounts[0].mid);
  ok('JSON 里带引号', JSON.stringify(merged.accounts[0].mid) === '"343791546"', JSON.stringify(merged.accounts[0].mid));
}

console.log('--- 9. 不传 fromVersion 时退回读 cfg.schemaVersion(向后兼容) ---');
{
  const cfg = { schemaVersion: 0, accounts: [{ mid: 111 }], task: {} };
  const r = migrateConfigChain(cfg, { log: () => {} });
  ok('从 0 开始迁移', r.from === 0 && r.applied.length >= 1, r.from);
  ok('mid 转成字符串', typeof cfg.accounts[0].mid === 'string', typeof cfg.accounts[0].mid);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
