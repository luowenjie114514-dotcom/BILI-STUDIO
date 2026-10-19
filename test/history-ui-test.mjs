/**
 * v1.5.3(P2-9) 任务历史 —— **界面这一侧**的验收。
 *
 * 后端那份 `test/history-test.mjs` 证明的是「文件写没写、重启丢不丢」。
 * 这里补的是另一半: 主人眼睛能看到的地方对不对:
 *   1. 第 9 号小窗里真的有「🗑 清空历史」按钮, 而且没被标题遮住;
 *   2. 历史有数据时表格真的渲染出来(不是空占位);
 *   3. 点清空 -> 二次确认 -> 表格变回占位、文件被删、接口返回 0 条;
 *   4. 取消确认时不能删(误触保护);
 *   5. 全程页面无 JS 报错。
 *
 * 自己起服务 + 自己拉 Edge headless, 用临时数据目录, 不碰真实配置。
 * 用法: node test/history-ui-test.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { launchEdge, waitForDevtools, autoCleanup } = await import('./browser.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

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

async function startServer(port, dataDir) {
  const child = spawn(process.execPath, ['server.mjs', `--port=${port}`, '--no-open'], {
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

/** 极简 CDP 客户端 */
function makeCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 15000);
    });
  };
  return { ws, ready, send };
}

async function main() {
  const runDir = path.join(ROOT, '_testrun', `history-ui-${process.pid}`);
  const dataDir = path.join(runDir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const histFile = path.join(dataDir, 'history.jsonl');
  const port = await freePort();

  const srv = await startServer(port, dataDir);
  let edge = null;

  try {
    console.log('=== 1. 先造两条历史, 让表格有东西可渲染 ===');
    const rows = [
      { taskId: 'tUI0001', trigger: 'manual', startedAt: Date.now() - 60000, planned: 2, posted: 2, failed: 0, skipped: 0, ms: 12000, items: [] },
      { taskId: 'tUI0002', trigger: 'schedule', startedAt: Date.now() - 10000, planned: 3, posted: 1, failed: 1, skipped: 1, ms: 9000, items: [] },
    ];
    for (const r of rows) fs.appendFileSync(histFile, JSON.stringify(r) + '\n', 'utf8');
    // 重新加载: 历史是启动时读进内存的, 得重启一次才看得到
    srv.child.kill('SIGKILL');
    await sleep(600);
    const srv2 = await startServer(port, dataDir);

    edge = await launchEdge({ name: 'hist-ui' });
    await waitForDevtools(edge.port);
    let targets = [];
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`http://127.0.0.1:${edge.port}/json`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
      await sleep(200);
    }
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到可用的 page target');
    const cdp = makeCdp(page.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__jsErrors = [];
        addEventListener('error', (e) => window.__jsErrors.push(String(e.message)));
        addEventListener('unhandledrejection', (e) => window.__jsErrors.push('rejection: ' + String(e.reason)));`,
    });
    const evalJs = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
      return r.result?.value;
    };
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await sleep(3500);

    console.log('=== 2. 历史小窗和按钮 ===');
    ok(await evalJs('!!document.querySelector(\'.win[data-win="hist"]\')'), '第 9 号历史小窗存在');
    const btnExpr = `(() => { const w = document.querySelector('.win[data-win="hist"]');
      return !!w && [...w.querySelectorAll('button')].some((b) => b.textContent.includes('清空历史')); })()`;
    ok(await evalJs(btnExpr), '小窗里有「🗑 清空历史」按钮');
    // 历史小窗在工作区靠下, 先滚进视口 —— 不滚的话 getBoundingClientRect 在屏幕外,
    // elementFromPoint 会返回 null, 命中测试就没意义了
    await evalJs(`(() => { const b = [...document.querySelectorAll('.win[data-win="hist"] button')]
        .find((x) => x.textContent.includes('清空历史')); b.scrollIntoView({ block: 'center' }); })()`);
    await sleep(500);
    const btnBox = await evalJs(`(() => {
      const w = document.querySelector('.win[data-win="hist"]');
      const b = [...w.querySelectorAll('button')].find((x) => x.textContent.includes('清空历史'));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const head = w.querySelector('.win-head');
      const hr = head ? head.getBoundingClientRect() : { bottom: -1 };
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { w: Math.round(r.width), h: Math.round(r.height),
               inView: r.y >= 0 && r.bottom <= innerHeight && r.x >= 0 && r.right <= innerWidth,
               vis: r.y >= hr.bottom - 1 && r.width > 20,
               clickable: !!hit && (hit === b || b.contains(hit)),
               hitEl: hit ? hit.tagName + (hit.id ? '#' + hit.id : '') : null };
    })()`);
    ok(!!btnBox && btnBox.w > 40 && btnBox.h > 14, `按钮有尺寸 ${btnBox?.w}x${btnBox?.h}`, btnBox);
    ok(!!btnBox && btnBox.inView, '滚过去以后按钮在视口内', btnBox);
    ok(!!btnBox && btnBox.vis, '按钮在标题栏下方, 没被标题压住', btnBox);
    ok(!!btnBox && btnBox.clickable, `按钮点得到(命中 ${btnBox?.hitEl})`, btnBox);

    console.log('=== 3. 表格渲染 ===');
    const bodyHtml = await evalJs('document.getElementById("histBody").innerHTML');
    const trCount = await evalJs('document.querySelectorAll("#histBody tr").length');
    ok(trCount === 2, `表格有 2 行 ${trCount}`, trCount);
    ok(/manual/.test(bodyHtml) && /schedule/.test(bodyHtml), '两行分别带 manual / schedule 触发');
    ok(!/还没有跑过任务/.test(bodyHtml), '有数据时不再显示空占位');

    console.log('=== 4. 取消确认时不删 ===');
    const before = (await (await fetch(`http://127.0.0.1:${port}/api/task/history`)).json()).history.length;
    await evalJs('window.confirm = () => false; clearHistoryConfirm();');
    await sleep(600);
    ok(fs.existsSync(histFile), '取消确认后文件还在');
    const afterCancel = (await (await fetch(`http://127.0.0.1:${port}/api/task/history`)).json()).history.length;
    ok(afterCancel === before, `取消后条数没变 ${before} -> ${afterCancel}`, { before, afterCancel });

    console.log('=== 5. 确认后清空 ===');
    await evalJs('window.confirm = () => true; clearHistoryConfirm();');
    await sleep(900);
    const ct = await (await fetch(`http://127.0.0.1:${port}/api/task/history`)).json();
    ok(ct.history.length === 0, `接口返回 0 条 ${ct.history.length}`, ct.history.length);
    ok(!fs.existsSync(histFile), 'history.jsonl 被删掉了', fs.existsSync(histFile));
    const bodyAfter = await evalJs('document.getElementById("histBody").innerHTML');
    ok(/还没有跑过任务/.test(bodyAfter), '表格变回空占位');
    const toastText = await evalJs('(document.getElementById("toast")?.textContent || "").trim()');
    ok(/清空/.test(toastText), `弹出提示: ${toastText}`, toastText);

    console.log('=== 6. 页面无 JS 报错 ===');
    const errs = await evalJs('JSON.stringify(window.__jsErrors || [])');
    const list = JSON.parse(errs || '[]');
    ok(list.length === 0, `页面无 JS 报错 (${list.length})`, list);

    srv2.child.kill('SIGKILL');
  } finally {
    try { edge?.close(); } catch { /* ignore */ }
    try { srv.child.kill('SIGKILL'); } catch { /* ignore */ }
    await sleep(400);
    try { await fsp.rm(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e.message);
  process.exit(2);
});
