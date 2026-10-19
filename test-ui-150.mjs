// v1.5.0 的 UI 冒烟测试: 小窗化布局 / 窗口菜单 / 主题色 / 标题 / 站内终端
// 运行: node test-ui-150.mjs [--port=8901]
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
const OUT = arg('out', 'ui150');
const BASE = `http://127.0.0.1:${PORT}/`;
const DBG = 9336;
// profile 放模块级: 收尾(catch 里)也要能删到它
const PROFILE_DIR = path.join(process.cwd(), '.edge-150-profile');
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
    }, 20000);
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
    '--window-size=1500,1000', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank',
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
      addEventListener('unhandledrejection', (e) => window.__jsErrors.push('rejection: ' + String(e.reason)));
      try { localStorage.clear(); } catch (e) {}`,
  });
  await send('Page.navigate', { url: BASE });
  await sleep(4000);

  /* ---------- 1. 标题 + 小窗化布局 ---------- */
  const title = await evaluate(`document.querySelector('header h1').textContent`);
  console.log('  标题:', title);
  ok(/蓝色大肥鱼/.test(title), `标题改成「蓝色大肥鱼」`);
  ok(/自动化搬史/.test(title), '副标题是「自动化搬史」');

  const lay = await evaluate(`(() => {
    const ws = [...document.querySelectorAll('#workspace .win')];
    return { n: ws.length,
      bodies: ws.filter((w) => w.querySelector('.win-body')).length,
      heads: ws.filter((w) => w.querySelector('.win-head')).length,
      grips: ws.filter((w) => w.querySelector('.win-grip')).length,
      cards: document.querySelectorAll('#workspace > .card').length,
      ids: ws.map((w) => w.dataset.win) };
  })()`);
  console.log('  小窗:', JSON.stringify(lay));
  ok(lay.n === 11, `9 个分区 + 日志 + 历史 = ${lay.n} 个小窗`);
  ok(lay.cards === 0, '原来的 .card 都搬进小窗了');
  ok(lay.bodies === lay.n && lay.heads === lay.n && lay.grips === lay.n, '每个小窗都有标题栏/内容区/缩放手柄');
  const shot1 = await shot('1-layout');

  /* ---------- 2. 拖动 / 收起 / 关闭 ---------- */
  const before = await evaluate(`(() => { const w = document.querySelector('[data-win=acc]'); const r = w.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) }; })()`);
  const hb = await evaluate(`(() => { const r = document.querySelector('[data-win=acc] .win-head').getBoundingClientRect();
    return { x: Math.round(r.left + 60), y: Math.round(r.top + 12) }; })()`);
  await mouse('mousePressed', hb.x, hb.y);
  await mouse('mouseMoved', hb.x + 40, hb.y + 50);
  await mouse('mouseMoved', hb.x + 120, hb.y + 110);
  await mouse('mouseReleased', hb.x + 120, hb.y + 110);
  await sleep(400);
  const after = await evaluate(`(() => { const w = document.querySelector('[data-win=acc]'); const r = w.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), saved: !!localStorage.getItem('bili-studio.wins.v2') }; })()`);
  console.log('  拖动:', JSON.stringify(before), '→', JSON.stringify(after));
  ok(after.x > before.x + 60 && after.y > before.y + 60, `窗口被拖走了 (${before.x},${before.y}) → (${after.x},${after.y})`);
  ok(after.saved, '新位置记进了 localStorage');

  // 收起
  await evaluate(`document.querySelector('[data-win=acc] [data-act=min]').click()`);
  await sleep(300);
  const minState = await evaluate(`(() => { const w = document.querySelector('[data-win=acc]');
    return { min: w.classList.contains('min'), h: Math.round(w.getBoundingClientRect().height) }; })()`);
  ok(minState.min && minState.h < 60, `收起成一条 ${minState.h}px`);
  await evaluate(`document.querySelector('[data-win=acc] [data-act=min]').click()`);
  await sleep(300);
  ok(!(await evaluate(`document.querySelector('[data-win=acc]').classList.contains('min')`)), '再点展开');

  // 关闭 → 窗口菜单里能开回来
  await evaluate(`document.querySelector('[data-win=acc] [data-act=close]').click()`);
  await sleep(300);
  const closed = await evaluate(`(() => { const w = document.querySelector('[data-win=acc]');
    return { hidden: w.hidden, pill: !document.getElementById('recallPill').hidden }; })()`);
  ok(closed.hidden, '点 ✕ 关掉了');
  ok(!closed.pill, '只关一个窗口时不出气泡（气泡留给「全关掉」的情况）');

  // 全关掉 → 气泡出来；点气泡全回来
  await evaluate(`wins.list.forEach((w) => hideWin(w))`);
  await sleep(350);
  const allHidden = await evaluate(`(() => ({ pill: !document.getElementById('recallPill').hidden,
    visible: wins.list.filter((w) => !w.el.hidden).length }))()`);
  ok(allHidden.visible === 0 && allHidden.pill, '全关掉后右上角浮出「唤出」气泡');
  await evaluate(`recallAllWins()`);
  await sleep(500);
  const recalled = await evaluate(`(() => ({ pill: !document.getElementById('recallPill').hidden,
    visible: wins.list.filter((w) => !w.el.hidden).length }))()`);
  ok(recalled.visible === 11 && !recalled.pill, `点气泡把 ${recalled.visible} 个窗口全叫回来，气泡自己消失`);

  // 再单独关掉「账户」，后面用菜单开回来
  await evaluate(`document.querySelector('[data-win=acc] [data-act=close]').click()`);
  await sleep(300);

  /* ---------- 3. 顶栏「窗口」菜单 ---------- */
  await evaluate(`document.getElementById('winMenuBtn').click()`);
  await sleep(350);
  const menu = await evaluate(`(() => {
    const p = document.getElementById('winPop');
    return { open: !p.hidden, items: p.querySelectorAll('label').length,
             accChecked: !!p.querySelector('input[data-winbox=acc]')?.checked,
             runs: p.querySelectorAll('.wp-acts button').length };
  })()`);
  console.log('  窗口菜单:', JSON.stringify(menu));
  ok(menu.open, '「窗口」下拉打开');
  ok(menu.items === 11, `菜单里 ${menu.items} 个小窗`);
  ok(menu.accChecked === false, '关掉的「账户」在菜单里是未勾选');
  ok(menu.runs === 4, '菜单里有 全部显示/排回屏幕/全部收起/重置布局');
  const shot2 = await shot('2-winmenu');

  await evaluate(`document.querySelector('#winPopList input[data-winbox=acc]').click()`);
  await sleep(400);
  const reopened = await evaluate(`(() => { const w = document.querySelector('[data-win=acc]');
    return { hidden: w.hidden, menu: document.getElementById('winPop').hidden }; })()`);
  ok(!reopened.hidden, '在菜单里勾上，窗口回来了');
  ok(!reopened.menu, '菜单保持打开，方便连着开关好几个');
  await evaluate(`document.body.click()`);
  await sleep(300);
  ok(await evaluate(`document.getElementById('winPop').hidden`), '点页面别处菜单收起来');

  /* ---------- 3.5 AI 接口能不能真的点到 ---------- */
  // 回归: AI 窗内容长, 以前「保存/测试连通」被压在整页 1500px 之外, 一滚再滚也够不着
  await evaluate(`(async () => { hideWin(wins.byId.ai); })()`);
  await sleep(200);
  await evaluate(`toggleWinById('ai')`);
  await sleep(900);
  const aiUsable = await evaluate(`(() => {
    const ai = wins.byId.ai;
    const foot = ai.el.querySelector('.win-foot');
    const btn = foot && [...foot.querySelectorAll('button')].find(b => b.textContent.includes('测试连通'));
    if (!btn) return { hasFoot: !!foot, hasBtn: false };
    const body = ai.el.querySelector('.win-body');
    const y1 = btn.getBoundingClientRect().y;
    body.scrollTop = body.scrollHeight;
    const r = btn.getBoundingClientRect();
    const y2 = r.y;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hasFoot: !!foot, hasBtn: true, stable: Math.round(y1) === Math.round(y2),
             inView: r.top > 0 && r.bottom < innerHeight,
             reachable: !!(hit && btn.contains(hit)) };
  })()`);
  console.log('  AI 接口可操作性:', JSON.stringify(aiUsable));
  ok(aiUsable.hasFoot, 'AI 接口的操作栏是吸底的（不跟着内容滚）');
  ok(aiUsable.hasBtn, '吸底栏里有「测试连通」按钮');
  ok(aiUsable.stable, '滚到窗口最底, 按钮位置不动');
  ok(aiUsable.inView, '从菜单点开后整扇窗滚进了视口');
  ok(aiUsable.reachable, '「测试连通」真的点得到（元素命中测试通过）');
  await evaluate(`(() => { const b = wins.byId.ai.el.querySelector('.win-body'); b.scrollTop = 0; })()`);

  /* ---------- 4. 主题色 ---------- */
  const themes = await evaluate(`(() => {
    const sw = document.querySelectorAll('#themeSwatches .theme-sw');
    return { n: sw.length, before: getComputedStyle(document.body).getPropertyValue('--acc').trim() };
  })()`);
  console.log('  主题:', JSON.stringify(themes));
  ok(themes.n >= 6, `主题色有 ${themes.n} 个`);
  await evaluate(`document.querySelectorAll('#themeSwatches .theme-sw')[2].click()`);
  await sleep(400);
  const themed = await evaluate(`(() => ({ after: getComputedStyle(document.body).getPropertyValue('--acc').trim(),
      saved: localStorage.getItem('bili-studio.theme') }))()`);
  ok(themed.after !== themes.before, `换肤后主色变了 ${themes.before || '(空)'} → ${themed.after}`);
  ok(themed.saved === '2', '选了哪个主题记进了 localStorage');
  await evaluate(`document.querySelectorAll('#themeSwatches .theme-sw')[0].click()`);
  await sleep(300);

  /* ---------- 5. 终端 ---------- */
  const termHidden = await evaluate(`document.getElementById('termWin').hidden`);
  ok(termHidden, '终端默认是关着的');
  await evaluate(`document.getElementById('termBtn').click()`);
  await sleep(600);
  const termOpen = await evaluate(`(() => { const w = document.getElementById('termWin');
    return { open: !w.hidden, input: !!document.getElementById('termIn'),
             cwd: (document.getElementById('termCwd') || {}).textContent || '',
             lines: document.querySelectorAll('#termOut .tl').length }; })()`);
  console.log('  终端:', JSON.stringify(termOpen));
  ok(termOpen.open, '点顶栏「终端」打开了');
  ok(termOpen.input, '有命令输入框');
  // 只要求是「一个真实存在的绝对路径」—— 源码版跑在 bili-studio/，打包版跑在 WHALE/，
  // 硬编码目录名会让同一个 exe 换个地方部署就误报。
  ok(/^[A-Za-z]:[\\/]/.test(termOpen.cwd), `显示当前目录 ${termOpen.cwd}`);

  // 服务端自己的输出也要能流进来：保存一次设置，服务端会打一行「设置已保存」
  await evaluate(`fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })`);
  await sleep(1500);
  const srvLine = await evaluate(`document.getElementById('termOut').textContent.includes('设置已保存')`);
  ok(srvLine, '服务端自己的日志流进了终端（看到「设置已保存」）');

  // 敲一条命令
  await evaluate(`(() => { const i = document.getElementById('termIn'); i.value = 'echo hi-from-ui'; i.focus(); })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(1600);
  const ran = await evaluate(`(() => {
    const t = document.getElementById('termOut').textContent;
    return { hasEcho: t.includes('hi-from-ui'), hasIn: t.includes('> echo hi-from-ui'),
             hasCode: /退出码 0/.test(t), state: (document.getElementById('termState') || {}).textContent || '' };
  })()`);
  console.log('  执行:', JSON.stringify(ran));
  ok(ran.hasIn, '命令回显进了终端');
  ok(ran.hasEcho, '命令输出出来了 (hi-from-ui)');
  ok(ran.hasCode, '打印了退出码');
  ok(/空闲/.test(ran.state), `状态回到 ${ran.state}`);
  const shot3 = await shot('3-term');

  // cd：先回到项目根，再进 public
  const typeCmd = async (c) => {
    await evaluate(`(() => { const i = document.getElementById('termIn'); i.value = ${JSON.stringify(c)}; i.focus(); })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(1300);
    return evaluate(`(document.getElementById('termCwd') || {}).textContent || ''`);
  };
  const baseCwd = (await typeCmd('cd')).trim();
  ok(baseCwd.length > 3, `裸 cd 回到项目根 ${baseCwd}`);
  const upCwd = (await typeCmd('cd ..')).trim();
  console.log('  cd .. 之后:', upCwd);
  ok(upCwd !== baseCwd && baseCwd.startsWith(upCwd), `cd .. 生效，目录变成 ${upCwd}`);
  const backCwd = (await typeCmd('cd')).trim();
  ok(backCwd === baseCwd, `再裸 cd 回到项目根 ${backCwd}`);

  // 拖动终端
  const tb = await evaluate(`(() => { const w = document.getElementById('termWin'); const r = w.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), hx: Math.round(r.left + 90), hy: Math.round(r.top + 12) }; })()`);
  await mouse('mousePressed', tb.hx, tb.hy);
  await mouse('mouseMoved', tb.hx - 30, tb.hy + 40);
  await mouse('mouseMoved', tb.hx - 90, tb.hy + 90);
  await mouse('mouseReleased', tb.hx - 90, tb.hy + 90);
  await sleep(400);
  const tmoved = await evaluate(`(() => { const w = document.getElementById('termWin'); const r = w.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), saved: localStorage.getItem('bili-studio.termWin') }; })()`);
  console.log('  终端拖动:', JSON.stringify(tb), '→', JSON.stringify(tmoved));
  ok(tmoved.x < tb.x - 40 && tmoved.y > tb.y + 40, `终端被拖走了 (${tb.x},${tb.y}) → (${tmoved.x},${tmoved.y})`);
  ok(!!tmoved.saved, '终端位置记进了 localStorage');

  // cls 清屏
  await evaluate(`(() => { const i = document.getElementById('termIn'); i.value = 'cls'; i.focus(); })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(900);
  const lines = await evaluate(`document.querySelectorAll('#termOut .tl').length`);
  ok(lines === 0, `cls 清屏了 (${lines} 行)`);

  // 关掉再开，位置还在
  await evaluate(`hideTerm()`);
  await sleep(300);
  ok(await evaluate(`document.getElementById('termWin').hidden`), '✕ 能关掉终端');
  await evaluate(`showTerm()`);
  await sleep(700);
  const back = await evaluate(`(() => { const w = document.getElementById('termWin'); const r = w.getBoundingClientRect();
    return { hidden: w.hidden, x: Math.round(r.left), y: Math.round(r.top) }; })()`);
  ok(!back.hidden && Math.abs(back.x - tmoved.x) < 6 && Math.abs(back.y - tmoved.y) < 6, `再打开位置没变 (${back.x},${back.y})`);

  /* ---------- 6. 没报错 ---------- */
  const errs = await evaluate('window.__jsErrors || []');
  ok(errs.length === 0, `页面无 JS 报错 (${errs.length})${errs.length ? ' → ' + errs.join(' | ') : ''}`);

  await sleep(200);
  console.log(`\n截图: ${shot1} ${shot2} ${shot3}`);
  console.log(fails.length ? `\n❌ ${fails.length} 项失败:\n - ${fails.join('\n - ')}` : `\n✅ 全部通过`);
  try { killTree(child.pid); } catch { /* ignore */ }
  removeProfile(PROFILE_DIR);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('测试崩了:', e);
  try { killTree(child?.pid); } catch { /* ignore */ }
  removeProfile(PROFILE_DIR);
  process.exit(2);
});
