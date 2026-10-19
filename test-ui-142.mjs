// v1.4.2 的 UI 冒烟测试: 更新日志弹窗 + 日志小窗拖动/改大小 + 私信「带上视频标题」开关
// 运行: node test-ui-142.mjs [--port=8901]
// 依赖 Edge headless + CDP(无第三方库)
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
const OUT = arg('out', 'ui142');
const BASE = `http://127.0.0.1:${PORT}/`;
const DBG = 9335;
// profile 放模块级: 收尾(catch 里)也要能删到它
const PROFILE_DIR = path.join(process.cwd(), '.edge-142-profile');
// 截图统一丢进 _testrun/shots, 别在项目根目录堆一地的 png
const SHOT_DIR = path.join(process.cwd(), '_testrun', 'shots');

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
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
});

async function main() {
  const profile = PROFILE_DIR;
  await fs.rm(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${profile}`,
    '--window-size=1400,1000', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

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

  /* ---------- 1. 更新日志弹窗 ---------- */
  const hasBtn = await evaluate(`[...document.querySelectorAll('header button')].some((b) => b.textContent.includes('更新日志'))`);
  ok(hasBtn, '顶栏右上角有「更新日志」按钮');

  await evaluate(`[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('更新日志')).click()`);
  await sleep(900);
  let cl = await evaluate(`(() => {
    const w = document.getElementById('clWrap');
    const b = document.getElementById('clBody');
    return { open: !!w && !w.hidden, len: b ? b.textContent.length : 0,
             ver: (document.getElementById('clVer') || {}).textContent || '',
             heads: b ? b.querySelectorAll('h2,h1').length : 0,
             pills: b ? b.querySelectorAll('.cl-pill').length : 0,
             has141: b ? b.textContent.includes('1.4.1') : false };
  })()`);
  console.log('  弹窗:', JSON.stringify(cl));
  ok(cl.open, '点按钮弹出更新日志');
  ok(cl.len > 2000, `日志正文有内容 ${cl.len} 字`);
  ok(cl.has141, '正文里有 1.4.1 那一节');
  ok(cl.heads >= 3, `渲染出 ${cl.heads} 个版本标题`);
  ok(cl.pills >= 2, `版本号渲染成小标 ${cl.pills} 个`);
  ok(/v1\./.test(cl.ver), `标题栏显示当前版本 ${cl.ver}`);
  const shot1 = await shot('1-changelog');

  // Esc 关闭
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(400);
  ok(await evaluate(`document.getElementById('clWrap').hidden`), 'Esc 能关掉弹窗');

  // 点遮罩空白处关闭
  await evaluate(`[...document.querySelectorAll('header button')].find((b) => b.textContent.includes('更新日志')).click()`);
  await sleep(600);
  await mouse('mousePressed', 12, 500);
  await mouse('mouseReleased', 12, 500);
  await sleep(400);
  ok(await evaluate(`document.getElementById('clWrap').hidden`), '点空白处能关掉弹窗');

  /* ---------- 2. 日志小窗: 拖动 ---------- */
  await evaluate('window.scrollTo(0,0)');
  await sleep(900);
  const before = await evaluate(`(() => {
    const m = document.getElementById('logMini');
    const r = m.getBoundingClientRect();
    const h = m.querySelector('.logmini-head').getBoundingClientRect();
    return { hidden: m.hidden, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             hx: Math.round(h.x + h.width / 2), hy: Math.round(h.y + h.height / 2) };
  })()`);
  console.log('  拖动前:', JSON.stringify(before));
  ok(!before.hidden, '小窗已经自动出现');
  ok(await evaluate(`getComputedStyle(document.getElementById('logMini')).resize`) === 'both', '小窗开了 resize(可拖角改大小)');

  const dx = -180; const dy = 120;
  await mouse('mousePressed', before.hx, before.hy);
  await mouse('mouseMoved', before.hx + dx / 2, before.hy + dy / 2);
  await mouse('mouseMoved', before.hx + dx, before.hy + dy);
  await mouse('mouseReleased', before.hx + dx, before.hy + dy);
  await sleep(500);
  const after = await evaluate(`(() => {
    const m = document.getElementById('logMini');
    const r = m.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), docked: m.classList.contains('dock'),
             saved: localStorage.getItem('bili-studio.miniWin') };
  })()`);
  console.log('  拖动后:', JSON.stringify(after));
  ok(Math.abs(after.x - (before.x + dx)) <= 6 && Math.abs(after.y - (before.y + dy)) <= 6,
    `拖到了新位置 (${before.x},${before.y}) → (${after.x},${after.y})`);
  ok(!after.docked, '拖动没有把窗口误收成一条');
  ok(!!after.saved, '拖动后的位置记进了 localStorage');
  const shot2 = await shot('2-dragged');

  // 改大小(模拟拖右下角: 直接改 CSS 尺寸, 靠 ResizeObserver 记住)
  await evaluate(`(() => {
    const m = document.getElementById('logMini');
    m.style.width = '520px'; m.style.height = '340px'; return true;
  })()`);
  await sleep(900);
  const sized = await evaluate(`(() => {
    const m = document.getElementById('logMini');
    const r = m.getBoundingClientRect();
    const g = JSON.parse(localStorage.getItem('bili-studio.miniWin') || '{}');
    return { w: Math.round(r.width), h: Math.round(r.height), gw: g.w, gh: g.h };
  })()`);
  console.log('  改大小:', JSON.stringify(sized));
  ok(sized.w === 520 && sized.h === 340, `尺寸变成 ${sized.w}x${sized.h}`);
  ok(sized.gw === 520 && sized.gh === 340, '新尺寸记进了 localStorage');

  // 刷新后位置/尺寸还在
  await evaluate('window.scrollTo(0,0)');
  await send('Page.navigate', { url: BASE });
  await sleep(3600);
  await evaluate('window.scrollTo(0,0)');
  await sleep(900);
  const reloaded = await evaluate(`(() => {
    const m = document.getElementById('logMini');
    const r = m.getBoundingClientRect();
    return { hidden: m.hidden, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
  })()`);
  console.log('  刷新后:', JSON.stringify(reloaded));
  ok(!reloaded.hidden, '刷新后小窗照旧自动出现');
  ok(reloaded.w === 520 && reloaded.h === 340, '刷新后尺寸被记住了');
  ok(Math.abs(reloaded.x - after.x) <= 6, '刷新后位置被记住了');

  /* ---------- 3. ⚙ 面板: 带上视频标题 ---------- */
  await evaluate(`(() => { const g = document.getElementById('dmSetBtn'); g.scrollIntoView({block:'center'}); return true; })()`);
  await sleep(600);
  // v1.5 「任务参数」也是小窗, 可能被关着 —— 先确保它在
  await evaluate(`(() => { const w = wins.byId.task; if (w && w.el.hidden) showWin(w);
    if (w && w.el.classList.contains('min')) toggleWinMin(w); return true; })()`);
  await sleep(400);
  await evaluate(`(() => { const g = document.getElementById('dmSetBtn'); g.click(); return true; })()`);
  await sleep(500);
  const sw = await evaluate(`(() => {
    const el = document.getElementById('dmTitle');
    const pop = document.getElementById('dmPop');
    const r = el ? el.getBoundingClientRect() : null;
    const pr = pop.getBoundingClientRect();
    // 命中测试: 面板中间那个点是不是真的被面板接住了(防止被日志小窗之类盖住)
    const hit = document.elementFromPoint(pr.x + pr.width / 2, pr.y + pr.height / 2);
    return { inPop: !!(el && pop && pop.contains(el)), checked: !!el && el.checked,
             w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
             appearance: el ? getComputedStyle(el).appearance : '',
             popInView: pr.top >= 0 && pr.bottom <= innerHeight && pr.left >= 0,
             onTop: !!(hit && pop.contains(hit)),
             label: el ? (el.closest('label') || {}).textContent.trim().slice(0, 20) : '' };
  })()`);
  console.log('  开关:', JSON.stringify(sw));
  ok(sw.inPop, '⚙ 面板里有「带上视频标题」开关');
  ok(sw.checked, '默认是打开的');
  ok(sw.w === 15 && sw.h === 15 && sw.appearance === 'none',
    `复选框被正确重置成小方框 (${sw.w}x${sw.h}, appearance=${sw.appearance})`);
  ok(sw.popInView, '面板完整落在视口内');
  ok(sw.onTop, '面板没被日志小窗盖住(命中测试通过)');
  const shot3 = await shot('3-dmswitch');

  // 关掉它 -> 应该存进配置
  await evaluate(`(() => { const el = document.getElementById('dmTitle'); el.click(); return true; })()`);
  await sleep(1200);
  const st1 = await fetch(BASE + 'api/state').then((r) => r.json());
  ok(st1.task.dmTitle === false, '关掉后服务端 dmTitle=false');

  // 再打开, 恢复默认
  await evaluate(`(() => { const el = document.getElementById('dmTitle'); el.click(); return true; })()`);
  await sleep(1200);
  const st2 = await fetch(BASE + 'api/state').then((r) => r.json());
  ok(st2.task.dmTitle === true, '再点一次回到 dmTitle=true');

  const errs = await evaluate('window.__jsErrors');
  ok(!errs || errs.length === 0, `页面无 JS 报错 (${(errs || []).length})`);

  console.log('\n截图:', [shot1, shot2, shot3].join(' '));
  killTree(child.pid);
  removeProfile(PROFILE_DIR);   // 不删的话每跑一次就在项目里留一个 55MB 的 profile
  if (fails.length) {
    console.log(`\n❌ ${fails.length} 项失败`);
    process.exit(1);
  }
  console.log('\n✅ 全部通过');
}

main().catch((e) => {
  console.error('测试异常:', e.message);
  try { killTree(child?.pid); } catch { /* ignore */ }
  removeProfile(PROFILE_DIR);
  process.exit(1);
});
