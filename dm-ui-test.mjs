// 私信形态悬浮面板的 UI 冒烟测试: 用 Edge headless + CDP 真点一遍
// 运行: node dm-ui-test.mjs [--port=8899] [--out=dm-ui]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { killTree, removeProfile } from './test/browser.mjs';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const PORT = arg('port', '8899');
const OUT = arg('out', 'dm-ui');
const BASE = `http://127.0.0.1:${PORT}/`;
const DBG = 9333;

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description || ''));
  return r.result?.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  await fs.mkdir(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `${OUT}-${name}.png`);
  await fs.writeFile(file, Buffer.from(r.data, 'base64'));
  return file;
}

/** main() 里拉起来的 Edge 进程 —— 放外层, finally 才收得到 */
let edgePid = 0;
/** 测试用的 Edge profile 目录 —— 同样放外层, 收尾要删(不删每跑一次留 55MB) */
const PROFILE_DIR = path.join(process.cwd(), '.edge-dm-profile');
// 截图统一丢进 _testrun/shots, 别在项目根目录堆一地的 png
const SHOT_DIR = path.join(process.cwd(), '_testrun', 'shots');

async function main() {
  const profile = PROFILE_DIR;
  await fs.rm(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${DBG}`,
    `--user-data-dir=${profile}`,
    '--window-size=1400,1000',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore' });
  edgePid = child.pid;

  // 等调试端口
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
  await sleep(3500);

  // 页面起来了没
  const title = await evaluate('document.title');
  ok(/蓝色大肥鱼/.test(title || ''), `页面标题正常: ${title}`);

  // 控件存在
  ok(await evaluate('!!document.getElementById("dmSetBtn")'), '齿轮按钮存在');
  ok(await evaluate('document.getElementById("dmPop").hidden === true'), '面板默认隐藏');
  ok(await evaluate('document.querySelectorAll("input[name=dmForm]").length === 2'), '面板里有 2 个形态选项');
  ok(await evaluate('!!document.getElementById("dmForm") === false'), '旧的 inline select 已移除');

  // 滚到私信那一行
  await evaluate('document.getElementById("dmMode").scrollIntoView({block:"center"})');
  await sleep(400);
  const closedShot = await shot('1-closed');

  // 点齿轮 -> 打开
  await evaluate('document.getElementById("dmSetBtn").click()');
  await sleep(350);
  ok(await evaluate('document.getElementById("dmPop").hidden === false'), '点齿轮后面板出现');
  ok(await evaluate('document.getElementById("dmSetBtn").classList.contains("on")'), '齿轮高亮');
  const rect = await evaluate(`(() => { const r = document.getElementById('dmPop').getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height,
      inView: r.y >= 0 && r.bottom <= innerHeight && r.x >= 0 && r.right <= innerWidth,
      overflowsSection: (() => { const s = document.getElementById('dmPop').closest('section');
        if (!s) return false;
        const sr = s.getBoundingClientRect();
        return r.right > sr.right || r.bottom > sr.bottom; })()}; })()`);
  console.log('  面板几何:', JSON.stringify(rect));
  ok(rect.w > 280 && rect.h > 90, `面板有尺寸 ${rect.w}x${rect.h}`);
  ok(rect.inView, '面板完整落在视口内');
  const openShot = await shot('2-open');

  // 点面板内部 -> 不该关闭
  await evaluate(`(() => {
    const pop = document.getElementById('dmPop');
    const r = pop.getBoundingClientRect();
    // 打在面板右边缘内侧的一个空白点: 既在面板里, 又不会碰到任何选项
    const x = r.right - 12;
    const y = r.top + 18;
    const hit = document.elementFromPoint(x, y);
    const t = (hit && pop.contains(hit)) ? hit : pop;
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
    return true;
  })()`);
  await sleep(200);
  ok(await evaluate('document.getElementById("dmPop").hidden === false'), '点面板内部不会误关');

  // 选「文本+链接」-> 立即保存
  await evaluate(`(() => { const r = document.querySelector('input[name=dmForm][value=texturl]');
    r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await sleep(1200);
  const saved = await (await fetch(`${BASE}api/state`)).json();
  ok(saved.task.dmForm === 'texturl', `选文本+链接后已保存 dmForm=${saved.task.dmForm}`);

  // 再点齿轮 -> 关闭
  await evaluate('document.getElementById("dmSetBtn").click()');
  await sleep(250);
  ok(await evaluate('document.getElementById("dmPop").hidden === true'), '再点齿轮面板收起');

  // 打开后点页面别处 -> 关闭
  await evaluate('document.getElementById("dmSetBtn").click()');
  await sleep(200);
  await evaluate('document.querySelector("h1,header,.topbar,body").click()');
  await sleep(250);
  ok(await evaluate('document.getElementById("dmPop").hidden === true'), '点别处面板自动收起');

  // 打开后 Esc -> 关闭
  await evaluate('document.getElementById("dmSetBtn").click()');
  await sleep(150);
  await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
  await sleep(200);
  ok(await evaluate('document.getElementById("dmPop").hidden === true'), 'Esc 也能收起');

  // 刷新页面: 状态应回填到「文本+链接」
  await send('Page.reload');
  await sleep(3500);
  ok(await evaluate('document.querySelector("input[name=dmForm][value=texturl]").checked === true'),
    '刷新后回填到已保存的形态');

  // 选回卡片, 收尾, 并截一张卡片选中态
  await evaluate(`(() => { const r = document.querySelector('input[name=dmForm][value=card]');
    r.checked = true; r.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
  await sleep(1000);
  await evaluate('document.getElementById("dmMode").scrollIntoView({block:"center"})');
  await evaluate('document.getElementById("dmSetBtn").click()');
  await sleep(350);
  const cardShot = await shot('3-card');
  ok(await evaluate('document.querySelector("input[name=dmForm][value=card]").checked === true'),
    '卡片选项处于选中态');

  const errs = await evaluate('(window.__jsErrors || []).length');
  ok(errs === 0, `页面无 JS 报错 (${errs})`);

  console.log('\n截图:', closedShot, openShot, cardShot);
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
  // 只收自己拉起来的那棵 Edge 进程树 —— 按镜像名 taskkill 会关掉主人的浏览器
  killTree(edgePid);
  removeProfile(PROFILE_DIR);
  process.exit(code);
}
