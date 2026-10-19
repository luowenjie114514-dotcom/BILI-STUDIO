/**
 * 一键跑全部测试(v1.6.0 新增, 解决 P1-6)。
 *
 * 以前的问题:
 *   - 每个测试都得手动 `node server.mjs --port=8899` 起服务, 忘了起就一片红;
 *   - 端口复用导致测到上一次残留的旧进程;
 *   - UI 测试还会误连到打包好的旧 exe 上, 改完源码却"测试通过", 白高兴一场;
 *   - 测试跑完在项目里留下一堆 data/ 和截图。
 *
 * 这个 runner 的做法:
 *   1. 自己 spawn 一个**源码模式**服务(node server.mjs), 端口随机, 数据目录用
 *      项目内的 _testrun/<pid>/data —— 沙箱允许, 跑完整个删掉。
 *   2. 绝对不复用 8899/8901 这类常用端口, 也不用 dist 里的 exe。
 *   3. 按顺序跑, 每个测试拿自己的超时; 一个挂了不影响后面的。
 *   4. 最后打印汇总表, 有失败就 exit 1。
 *
 * 用法:
 *   node test/run-all.mjs                 # 全部
 *   node test/run-all.mjs --only=ui       # 名字里含 ui 的
 *   node test/run-all.mjs --list          # 只列出会跑哪些
 *   node test/run-all.mjs --keep          # 保留临时目录排查
 *   node test/run-all.mjs --bail          # 第一个失败就停
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const has = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const val = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const KEEP = has('keep');
const BAIL = has('bail');
const ONLY = val('only', '');
const LIST = has('list');

/**
 * 测试清单。
 *   kind: unit  = 纯 Node, 不需要服务, 直接跑
 *         api   = 需要服务, 通过 BASE 环境变量拿到地址
 *         ui    = 会自己拉 Edge headless, 更慢
 * 每个测试的约定: exit 0 = 通过。
 */
const TESTS = [
  { name: 'config-migrate', file: 'test/config-migrate-test.mjs', kind: 'unit', timeout: 60_000 },
  { name: 'util', file: '.util-test.mjs', kind: 'unit', timeout: 60_000 },
  { name: 'api-smoke', file: 'test/api-smoke.mjs', kind: 'api', timeout: 120_000 },
  { name: 'dm-text', file: 'test-dm-text.mjs', kind: 'api', timeout: 180_000, opts: ['--port'] },
  // P2-9: 任务历史落盘, 自己起服务+自己重启, 所以归 unit(不需要外部服务)
  { name: 'history', file: 'test/history-test.mjs', kind: 'unit', timeout: 180_000 },
  // 历史小窗那一侧: 自己起服务 + 自己拉 Edge, 所以也归 unit
  { name: 'history-ui', file: 'test/history-ui-test.mjs', kind: 'unit', timeout: 240_000 },
  // 主题配色(v1.5.4): 接口存取 + 配置迁移; 编辑器那一侧自己拉 Edge
  { name: 'theme-api', file: 'test/theme-api-test.mjs', kind: 'unit', timeout: 120_000 },
  { name: 'theme-ui', file: 'test/theme-ui-test.mjs', kind: 'unit', timeout: 240_000 },
  { name: 'ui-142', file: 'test-ui-142.mjs', kind: 'ui', timeout: 180_000 },
  { name: 'ui-150', file: 'test-ui-150.mjs', kind: 'ui', timeout: 240_000 },
  { name: 'minilog', file: 'minilog-test.mjs', kind: 'ui', timeout: 180_000 },
  { name: 'dm-ui', file: 'dm-ui-test.mjs', kind: 'ui', timeout: 180_000 },
  // 打包产物验收: 自己拉 dist\bili-studio.exe + 自己的临时数据目录, 所以也归 unit
  // (以前它要人先手动起实例, 而且会把那个实例的真实配置写脏 —— 见 CHANGELOG 1.5.4)
  { name: 'exe', file: 'test-exe.mjs', kind: 'unit', timeout: 300_000 },
].filter((t) => (ONLY ? t.name.includes(ONLY) || t.file.includes(ONLY) : true));

if (LIST) {
  console.log('会跑的测试:');
  for (const t of TESTS) console.log(`  ${t.kind.padEnd(4)} ${t.name.padEnd(16)} ${t.file}`);
  process.exit(0);
}

/** 找一个空闲端口: 让系统分配, 比硬编码 8899 可靠 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(port, { tries = 60, gap = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await sleep(gap);
  }
  throw new Error(`服务在 ${tries * gap}ms 内没起来 (port ${port})`);
}

function runOne(test, ctx) {
  return new Promise((resolve) => {
    const file = path.join(ROOT, test.file);
    if (!fs.existsSync(file)) {
      resolve({ ...test, status: 'skip', ms: 0, out: '文件不存在, 跳过' });
      return;
    }
    const args = [file];
    // 有些老测试接受 --port= / 位置参数, 这里都塞上, 兼容两种写法
    if (test.kind !== 'unit') {
      args.push(`--port=${ctx.port}`, String(ctx.port));
    }
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: {
        ...process.env,
        BASE: `http://127.0.0.1:${ctx.port}`,
        PORT: String(ctx.port),
        DSH_BILI_STUDIO_DATA: ctx.dataDir,
        NODE_NO_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    const cap = (buf) => {
      out += buf.toString();
      if (out.length > 400_000) out = out.slice(-400_000);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);

    const timer = setTimeout(() => {
      out += `\n[runner] 超时 ${test.timeout}ms, 已杀`;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, test.timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const status = code === 0 ? 'pass' : 'fail';
      resolve({ ...test, status, code, ms, out });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ...test, status: 'fail', ms: Date.now() - started, out: `spawn 失败: ${e.message}` });
    });
  });
}

async function main() {
  console.log('bili-studio 测试 runner');
  console.log(`  工作目录: ${ROOT}`);
  console.log(`  测试数量: ${TESTS.length}${ONLY ? ` (过滤: ${ONLY})` : ''}\n`);

  const runDir = path.join(ROOT, '_testrun', String(process.pid));
  const dataDir = path.join(runDir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const port = await freePort();
  console.log(`  临时数据目录: ${path.relative(ROOT, dataDir)}`);
  console.log(`  服务端口: ${port}\n`);

  // 起源码服务 —— 明确用 server.mjs, 不碰 dist 里的 exe
  const serverLog = path.join(runDir, 'server.log');
  const logFd = fs.openSync(serverLog, 'w');
  const server = spawn(process.execPath, ['server.mjs', `--port=${port}`, '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_BILI_STUDIO_DATA: dataDir, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', logFd, logFd],
  });

  let serverUp = false;
  try {
    await waitForServer(port);
    serverUp = true;
    console.log('  [服务] 已就绪\n');
  } catch (e) {
    console.log(`  [服务] 起不来: ${e.message}`);
    console.log(`  详见 ${path.relative(ROOT, serverLog)}\n`);
  }

  const results = [];
  const needServer = TESTS.some((t) => t.kind !== 'unit');
  if (!serverUp && needServer) {
    console.log('  服务不可用, 只跑不需要服务的单元测试.\n');
  }

  for (const test of TESTS) {
    if (!serverUp && test.kind !== 'unit') {
      results.push({ ...test, status: 'skip', ms: 0, out: '服务没起来' });
      continue;
    }
    process.stdout.write(`  ${test.name.padEnd(16)} 跑… `);
    const r = await runOne(test, { port, dataDir });
    results.push(r);
    const tag = r.status === 'pass' ? 'OK' : r.status === 'skip' ? '跳过' : '失败';
    console.log(`${tag}  ${(r.ms / 1000).toFixed(1)}s`);
    if (r.status === 'fail') {
      const tail = r.out.trim().split('\n').slice(-14).join('\n');
      console.log('    ┌──── 输出尾部 ────');
      for (const line of tail.split('\n')) console.log(`    │ ${line}`);
      console.log('    └──────────────────');
      if (BAIL) { console.log('\n  --bail: 第一个失败就停'); break; }
    }
  }

  // 收摊
  try { server.kill('SIGKILL'); } catch { /* ignore */ }
  try { fs.closeSync(logFd); } catch { /* ignore */ }
  await sleep(400);

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;

  console.log('\n================ 汇总 ================');
  for (const r of results) {
    const tag = r.status === 'pass' ? '✅' : r.status === 'skip' ? '⏭ ' : '❌';
    console.log(`  ${tag} ${r.name.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  console.log(`\n  通过 ${pass} / 失败 ${fail} / 跳过 ${skip}`);

  if (KEEP) {
    console.log(`\n  临时目录保留: ${runDir}`);
  } else {
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // 老测试的截图现在也统一丢在 _testrun/shots 里, 一起清掉
    try { await fsp.rm(path.join(ROOT, '_testrun', 'shots'), { recursive: true, force: true }); } catch { /* ignore */ }
    // _testrun 空了就一起删掉
    try {
      const left = await fsp.readdir(path.join(ROOT, '_testrun'));
      if (!left.length) await fsp.rm(path.join(ROOT, '_testrun'), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('runner 崩了:', e);
  process.exit(2);
});
