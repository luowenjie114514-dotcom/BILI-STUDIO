// 主题色功能的接口冒烟测试: 起一个临时服务(独立 data 目录), 验 /api/ui/theme 存取 + 配置迁移。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8931 + Math.floor(Math.random() * 60);
const DATA = path.join(ROOT, '_testrun', `theme-${process.pid}`, 'data');

let pass = 0;
let fail = 0;
function ck(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name} ${extra}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(base, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${base}/api/state`);
      if (r.ok) return true;
    } catch { /* not yet */ }
    await sleep(200);
  }
  return false;
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  // 造一份「老配置」: 没有 ui 字段, schemaVersion 还是 1
  const oldCfg = {
    schemaVersion: 1,
    accounts: [],
    mentions: [],
    task: { dryRun: true },
    skin: { active: 'default' },
  };
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(oldCfg, null, 2), 'utf8');

  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), `--port=${PORT}`, '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_BILI_STUDIO_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const base = `http://127.0.0.1:${PORT}`;
  try {
    const up = await waitForServer(base);
    ck('服务起来了', up, stderr.slice(-400));
    if (!up) return;

    // 1) 老配置迁移后应该有 ui.theme
    const st = await (await fetch(`${base}/api/state`)).json();
    ck('老配置迁移到了 schemaVersion 2', Number(st.schemaVersion) === 2, `schema=${st.schemaVersion}`);
    ck('/api/state 里有 ui 字段', !!st.ui, JSON.stringify(st.ui));
    ck('ui.theme 初始为 null', st.ui && st.ui.theme === null, JSON.stringify(st.ui && st.ui.theme));
    const migrated = st.configVersion && st.configVersion.migrated;
    ck('迁移记录非空(说明真的跑了迁移)',
      !!migrated && Array.isArray(migrated.steps) && migrated.steps.length > 0,
      JSON.stringify(migrated));

    // 2) 存一套主题
    const custom = { bg: '#101820', acc: '#ff0055', 'card-deep': '#0a0a0a' };
    let r = await fetch(`${base}/api/ui/theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 7, custom }),
    });
    let j = await r.json();
    ck('POST /api/ui/theme 成功', r.ok && j.ok === true, JSON.stringify(j));
    ck('返回字节数合理', typeof j.bytes === 'number' && j.bytes > 10, `bytes=${j.bytes}`);

    // 3) 读回来
    const st2 = await (await fetch(`${base}/api/state`)).json();
    ck('preset 存住了', st2.ui.theme.preset === 7, JSON.stringify(st2.ui.theme));
    ck('custom 内容一致', JSON.stringify(st2.ui.theme.custom) === JSON.stringify(custom), JSON.stringify(st2.ui.theme.custom));

    // 4) 落到磁盘 config.json
    const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
    ck('config.json 里确实写了 ui.theme', !!onDisk.ui && onDisk.ui.theme && onDisk.ui.theme.preset === 7,
      JSON.stringify(onDisk.ui));

    // 5) 非法输入要拒
    r = await fetch(`${base}/api/ui/theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 'abc' }),
    });
    ck('preset 非整数被拒', !r.ok, `status=${r.status}`);

    r = await fetch(`${base}/api/ui/theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: -1 }),
    });
    ck('preset 负数被拒', !r.ok, `status=${r.status}`);

    // 脏 custom 里的非字符串值要被过滤掉, 而不是整单拒绝
    r = await fetch(`${base}/api/ui/theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: 0, custom: { acc: '#123456', bad: 123, 'x y': '#fff', ok: '#abcdef' } }),
    });
    j = await r.json();
    ck('脏 custom 仍接受', r.ok && j.ok, JSON.stringify(j));
    const st3 = await (await fetch(`${base}/api/state`)).json();
    const got = st3.ui.theme.custom || {};
    ck('非字符串值被过滤', got.bad === undefined && got.ok === '#abcdef', JSON.stringify(got));
    ck('非法键名被过滤', got['x y'] === undefined, JSON.stringify(got));

    // 6) 页面能拿到: index.html 里所有主题变量都用上了 var()
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    ck('index.html 仍有 :root 变量块', /:root\{/.test(html));
    const hardCoded = (html.match(/style="[^"]*#[0-9a-f]{6}/gi) || []).length;
    ck('内联样式里没有写死深色背景', hardCoded === 0, `找到 ${hardCoded} 处`);
  } finally {
    child.kill();
    await sleep(300);
    try { fs.rmSync(path.join(ROOT, '_testrun', `theme-${process.pid}`), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}  ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('测试崩了:', e);
  process.exit(1);
});
