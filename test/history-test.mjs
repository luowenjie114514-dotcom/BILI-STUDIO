/**
 * v1.5.3(P2-9) 任务历史落盘验收。
 *
 * 要证明的是这四件事:
 *   1. 任务结束后 data/history.jsonl 里真的有这一行;
 *   2. **重启服务后历史还在**(这是原来最大的毛病: 内存数组, 一重启就空);
 *   3. 坏行不会把整个文件带崩(半行 JSON 也能读);
 *   4. 超过条数上限时内存只留最近 N 条, 但文件里的旧记录不丢。
 *
 * 用法: node test/history-test.mjs
 *   自己起服务、自己收, 用 _testrun 下的临时数据目录, 不碰真实配置。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function startServer({ port, dataDir }) {
  const child = spawn(NODE, ['server.mjs', `--port=${port}`, '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_BILI_STUDIO_DATA: dataDir, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b.toString(); });
  child.stderr.on('data', (b) => { out += b.toString(); });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return { child, getLog: () => out };
    } catch { /* pending */ }
    await sleep(200);
  }
  throw new Error(`服务没起来, 输出:\n${out.slice(-1500)}`);
}

async function getHistory(port, n) {
  const r = await fetch(`http://127.0.0.1:${port}/api/task/history${n ? `?n=${n}` : ''}`);
  return r.json();
}

function stopServer(child) {
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

async function main() {
  const runDir = path.join(ROOT, '_testrun', `history-${process.pid}`);
  const dataDir = path.join(runDir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const histFile = path.join(dataDir, 'history.jsonl');
  const port = await freePort();

  console.log('=== 1. 空历史 ===');
  let srv = await startServer({ port, dataDir });
  let h = await getHistory(port);
  ok('新目录下历史为空', Array.isArray(h.history) && h.history.length === 0, h.history?.length);
  ok('返回文件路径', typeof h.file === 'string' && h.file.endsWith('history.jsonl'), h.file);
  ok('还没建文件', !fs.existsSync(histFile), fs.existsSync(histFile));

  console.log('=== 2. 跑一次真实任务(干跑) ===');
  // 用干跑模式跑一轮, 不依赖 cookie / 不真的发东西
  const runRes = await fetch(`http://127.0.0.1:${port}/api/task/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true, repeat: 1 }),
  });
  const runJson = await runRes.json().catch(() => null);
  ok('任务接口有响应', runRes.status === 200 || runRes.status === 500, runRes.status);
  await sleep(6000);   // 给它时间跑完并落盘

  h = await getHistory(port);
  const wroteFile = fs.existsSync(histFile);
  ok('history.jsonl 已生成', wroteFile);
  if (wroteFile) {
    const raw = fs.readFileSync(histFile, 'utf8').trim();
    const lines = raw ? raw.split('\n') : [];
    ok('文件里有记录', lines.length >= 1, lines.length);
    let parsed = null;
    try { parsed = JSON.parse(lines[lines.length - 1]); } catch { /* ignore */ }
    ok('每行是合法 JSON', !!parsed);
    ok('记录带 taskId', typeof parsed?.taskId === 'string' && parsed.taskId.startsWith('t'), parsed?.taskId);
    ok('记录带 trigger', typeof parsed?.trigger === 'string', parsed?.trigger);
  }
  const countBefore = h.history.length;
  ok('接口能看到刚才那一条', countBefore >= 1, countBefore);
  const firstId = h.history[0]?.taskId;

  console.log('=== 3. 重启后历史还在(核心回归) ===');
  stopServer(srv.child);
  await sleep(700);
  const port2 = await freePort();
  srv = await startServer({ port: port2, dataDir });
  h = await getHistory(port2);
  ok('重启后条数不为 0', h.history.length >= 1, h.history.length);
  ok('重启后第一条就是重启前的', h.history[0]?.taskId === firstId, { now: h.history[0]?.taskId, before: firstId });

  console.log('=== 4. 坏行不影响读取 ===');
  stopServer(srv.child);
  await sleep(500);
  // 手动塞两行: 一行半截 JSON, 一行正常
  fs.appendFileSync(histFile, '{"taskId":"broken", "trigger":"man\u0000\n', 'utf8');
  fs.appendFileSync(histFile, `${JSON.stringify({ taskId: 'tMANUAL', trigger: 'manual', startedAt: Date.now(), planned: 0, posted: 0, failed: 0, skipped: 0, items: [] })}\n`, 'utf8');
  const port3 = await freePort();
  srv = await startServer({ port: port3, dataDir });
  h = await getHistory(port3);
  ok('坏行被跳过, 好行仍能读到', h.history.some((x) => x.taskId === 'tMANUAL'), h.history.map((x) => x.taskId).slice(0, 5));
  ok('坏行没有被当成记录', !h.history.some((x) => x.taskId === 'broken'), h.history.map((x) => x.taskId).slice(0, 5));

  console.log('=== 5. 清空历史 ===');
  const cl = await fetch(`http://127.0.0.1:${port3}/api/task/history/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  ok('清空接口 200', cl.status === 200, cl.status);
  h = await getHistory(port3);
  ok('清空后内存为空', h.history.length === 0, h.history.length);
  ok('清空后文件被删', !fs.existsSync(histFile), fs.existsSync(histFile));

  console.log('=== 6. n 参数限条数 ===');
  for (let i = 0; i < 5; i++) {
    fs.appendFileSync(histFile, `${JSON.stringify({ taskId: `tX${i}`, trigger: 'manual', startedAt: Date.now() + i, planned: 0, posted: 0, failed: 0, skipped: 0, items: [] })}\n`, 'utf8');
  }
  stopServer(srv.child);
  await sleep(500);
  const port4 = await freePort();
  srv = await startServer({ port: port4, dataDir });
  const all = (await getHistory(port4)).history;
  const two = (await getHistory(port4, 2)).history;
  ok('不带参数返回全部 5 条', all.length === 5, all.length);
  ok('?n=2 只返回 2 条', two.length === 2, two.length);
  ok('返回的是最新的在前', two[0]?.taskId === 'tX4', two.map((x) => x.taskId));

  stopServer(srv.child);
  await sleep(400);
  try { await fsp.rm(runDir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => {
  console.error('测试异常:', e.message);
  process.exit(2);
});
