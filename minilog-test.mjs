// 右上角内嵌日志小窗的 UI 冒烟测试: Edge headless + CDP 真滚真点
// 运行: node minilog-test.mjs [--port=8901] [--out=minilog]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { killTree, removeProfile } from './test/browser.mjs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = arg('port', '8901');
const OUT = arg('out', 'minilog');
const BASE = `http://127.0.0.1:${PORT}/`;
const DBG = 9334;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) fails.push(msg);
};

let ws;
let msgId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
    }, 15000);
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${OUT}-${name}.png`);
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  return file;
}
const scrollTop = () => evaluate('window.scrollTo(0,0), window.scrollY');
const miniState = () => evaluate(`(() => {
  const m = document.getElementById('logMini');
  const b = document.getElementById('miniLog');
  const p = document.getElementById('logMiniPill');
  const r = m.getBoundingClientRect();
  return {
    exists: !!m, hidden: m.hidden, docked: m.classList.contains('dock'),
    lines: [...b.children].filter((c) => c.id !== 'miniEmpty').length,
    placeholder: !document.getElementById('miniEmpty').hidden,
    pill: !!p && !p.hidden,
    x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    right: Math.round(innerWidth - r.right), inView: r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
    bodyVisible: b.offsetHeight > 0,
  };
})()`);

/** main() 里拉起来的 Edge 进程 —— 放外层, finally 才收得到 */
let edgePid = 0;
/** 测试用的 Edge profile 目录 —— 同样放外层, 收尾要删(不删每跑一次留 55MB) */
const PROFILE_DIR = path.join(process.cwd(), '.edge-mini-profile');
// 截图统一丢进 _testrun/shots, 别在项目根目录堆一地的 png
const SHOT_DIR = path.join(process.cwd(), '_testrun', 'shots');

async function main() {
  const profile = PROFILE_DIR;
  await fs.rm(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
    '--window-size=1400,1000', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  edgePid = child.pid;

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DBG}/json`);
      targets = await r.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch { /* retry */ }
    await sleep(250);
  }
  if (!targets) throw new Error('Edge 调试端口没起来');
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error))); else resolve(m.result);
    }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__jsErrors = [];
      addEventListener('error', (e) => window.__jsErrors.push(String(e.message)));
      addEventListener('unhandledrejection', (e) => window.__jsErrors.push('rejection: ' + String(e.reason)));`,
  });
  await send('Page.navigate', { url: BASE });
  await sleep(3800);

  ok(/蓝色大肥鱼/.test(await evaluate('document.title') || ''), '页面打开正常');

  // 1) 先把「日志窗口好好地摆在屏幕上」→ 小窗应该收起来
  await evaluate(`(() => { showWin(wins.byId.log);
    document.getElementById('log').scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(900);
  let s = await miniState();
  console.log('  日志窗口在屏幕上:', JSON.stringify(s));
  ok(s.exists, '右上角小窗存在');
  ok(s.hidden, '日志窗口好好在屏幕上时，小窗收起来不抢地方');

  // 2) 把「运行日志」窗口关掉 -> 小窗自动顶上（不然就彻底看不到日志了）
  await evaluate(`document.querySelector('[data-win=log] [data-act=close]').click()`);
  await sleep(700);
  s = await miniState();
  console.log('  关掉日志窗口:', JSON.stringify(s));
  ok(!s.hidden, '关掉日志窗口后小窗自动出现');
  ok(s.inView, '小窗完整落在视口内');
  ok(s.right <= 24 && s.y <= 80, `小窗贴在右上角 (右距${s.right}px 上距${s.y}px)`);
  ok(s.w > 300 && s.h < 340, `小窗尺寸合理 ${s.w}x${s.h}`);
  const shot1 = await shot('1-auto');

  // 3) 把窗口叫回来 -> 小窗自动收起
  await evaluate(`(() => { showWin(wins.byId.log);
    document.getElementById('log').scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(900);
  s = await miniState();
  console.log('  日志窗口回来:', JSON.stringify(s));
  ok(s.hidden, '日志窗口回来后小窗自动收起');
  const shot2 = await shot('2-hidden');

  // 3b) 再关一次，继续测后面的交互
  await evaluate(`hideWin(wins.byId.log)`);
  await sleep(700);
  s = await miniState();
  ok(!s.hidden, '再关掉日志窗口，小窗又出现');

  // 4) 点标题栏 -> 收成一条(dock)
  await evaluate('document.querySelector(".logmini-head").click()');
  await sleep(300);
  s = await miniState();
  console.log('  dock:', JSON.stringify(s));
  ok(s.docked && !s.bodyVisible, '点标题栏收成一条');
  ok(s.h < 60, `收起后高度很小 ${s.h}px`);
  const shot3 = await shot('3-docked');
  await evaluate('document.querySelector(".logmini-head").click()');
  await sleep(300);
  s = await miniState();
  ok(!s.docked && s.bodyVisible, '再点一次展开回来');

  // 5) ✕ -> 小窗消失, 留下小气泡
  await evaluate('document.querySelector(".logmini-x").click()');
  await sleep(350);
  s = await miniState();
  ok(s.hidden && s.pill, '✕ 把小窗收成右上角小气泡');
  const shot4 = await shot('4-pill');

  // 6) 点气泡 -> 小窗回来
  await evaluate('document.getElementById("logMiniPill").click()');
  await sleep(350);
  s = await miniState();
  ok(!s.hidden && !s.pill, '点气泡能把小窗调回来');

  // 7) 后端的日志要同步进小窗
  const before = (await miniState()).lines;
  await fetch(`${BASE}api/settings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task: {} }),
  });
  await sleep(2200);
  const after = (await miniState()).lines;
  ok(after > before, `新日志会进小窗 (${before} → ${after})`);
  const tail = await evaluate(`(() => { const b = document.getElementById('miniLog');
    return b.children.length ? b.children[b.children.length - 1].textContent : ''; })()`);
  ok(/设置已保存/.test(tail), `小窗最后一行是刚产生的日志: ${String(tail).slice(0, 40)}`);

  // 8) 小窗和完整日志内容一致(条数一样)
  const counts = await evaluate(`({full: document.getElementById('log').children.length,
    mini: [...document.getElementById('miniLog').children].filter((c) => c.id !== 'miniEmpty').length })`);
  ok(counts.full === counts.mini, `两边条数一致 full=${counts.full} mini=${counts.mini}`);

  // 9) 「跳到完整日志」要把日志窗口叫回来
  await evaluate(`hideWin(wins.byId.log)`);
  await sleep(600);
  await evaluate(`(() => { const a = [...document.querySelectorAll('.logmini-foot a')].find((x) => /完整日志/.test(x.textContent));
    a.click(); return true; })()`);
  await sleep(1200);
  const backFull = await evaluate(`({ win: !wins.byId.log.el.hidden, mini: document.getElementById('logMini').hidden })`);
  ok(backFull.win, '点「跳到完整日志」把日志窗口叫回来了');
  ok(backFull.mini, '日志窗口回来后小窗收起');

  // 10) 清空日志会把小窗一起清掉
  await evaluate('clearLogs()');
  await sleep(1200);
  const cleared = await evaluate(`({full: document.getElementById('log').children.length,
    mini: [...document.getElementById('miniLog').children].filter((c) => c.id !== 'miniEmpty').length })`);
  ok(cleared.full === 0 && cleared.mini === 0, `清空后两边都空了 full=${cleared.full} mini=${cleared.mini}`);
  ok(await evaluate('document.getElementById("miniEmpty").hidden === false'), '清空后小窗显示「还没有日志」占位');
  ok(await evaluate('document.getElementById("logMini").classList.contains("empty")'), '清空后小窗自动压矮');

  // 11) 刷新后：日志窗口的记忆还在 → 把它摆到屏幕上，小窗就不该出现
  await send('Page.reload');
  await sleep(3800);
  const afterReload = await evaluate(`({ hidden: wins.byId.log.el.hidden, mini: document.getElementById('logMini').hidden })`);
  console.log('  刷新后:', JSON.stringify(afterReload));
  ok(afterReload.hidden === false, '刷新后日志窗口的状态被记住了（开着）');
  await evaluate(`(() => { document.getElementById('log').scrollIntoView({ block: 'center' }); return true; })()`);
  await sleep(900);
  s = await miniState();
  console.log('  摆到屏幕上:', JSON.stringify(s));
  ok(s.hidden, '刷新后日志窗口在屏幕上，小窗照旧不出现');
  const shot5 = await shot('5-reload');

  const errs = await evaluate('(window.__jsErrors || []).length');
  ok(errs === 0, `页面无 JS 报错 (${errs})`);

  console.log('\n截图:', shot1, shot2, shot3, shot4, shot5);
  console.log(fails.length ? `\n❌ ${fails.length} 项失败` : '\n✅ 全部通过');
  return fails.length ? 1 : 0;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('测试异常:', e.message);
  code = 2;
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  // 只收自己拉起来的那棵 Edge 进程树, 绝不能按镜像名杀(会连主人正在用的浏览器一起关掉)
  killTree(edgePid);
  removeProfile(PROFILE_DIR);
  process.exit(code);
}
