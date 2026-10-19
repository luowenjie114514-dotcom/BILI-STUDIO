// 主题色编辑器的 UI 测试: 真浏览器里点色块、改单项颜色、存自定义、换回预设、刷新后还在。
// 起服务 + 起 headless Edge(只杀自己那棵树, 不碰主人的浏览器)。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 8990 + Math.floor(Math.random() * 60);
const DATA = path.join(ROOT, '_testrun', `theme-ui-${process.pid}`, 'data');

const { launchEdge, waitForDevtools, killTree, removeProfile } = await import(
  pathToFileURL(path.join(ROOT, 'test', 'browser.mjs')).href
);

let pass = 0;
let fail = 0;
function ck(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name} ${extra}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(base, timeoutMs = 25000) {
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

/* ---------- 极简 CDP ---------- */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const { resolve, reject } = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
  return {
    ready,
    close: () => ws.close(),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const myId = ++id;
        waiting.set(myId, { resolve, reject });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
  };
}

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), `--port=${PORT}`, '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, DSH_BILI_STUDIO_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let edgePid = 0;
  let edgeProfile = '';
  let client = null;
  const base = `http://127.0.0.1:${PORT}`;
  try {
    ck('服务起来了', await waitForServer(base));

    const edge = await launchEdge({ name: 'theme' });
    edgePid = edge.child.pid;
    edgeProfile = edge.profile;
    await waitForDevtools(edge.port);
    const targets = await (await fetch(`http://127.0.0.1:${edge.port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page');
    client = cdp(page.webSocketDebuggerUrl);
    await client.ready;
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__jsErrors=[];addEventListener("error",e=>window.__jsErrors.push(String(e.message)));'
        + 'addEventListener("unhandledrejection",e=>window.__jsErrors.push("reject:"+e.reason));',
    });
    await client.send('Page.navigate', { url: base });
    await sleep(1500);

    const evalJs = async (expr) => {
      const r = await client.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
      return r.result.value;
    };

    // 1) 色块
    ck('7 个预设色块都在', (await evalJs("document.querySelectorAll('#themeSwatches .theme-sw').length")) === 7);
    ck('默认选中第一个', (await evalJs("document.querySelectorAll('#themeSwatches .theme-sw.sel').length")) === 1);

    // 2) 编辑器默认是收起的, 点开才有取色器
    ck('配色编辑器默认收起', (await evalJs("document.getElementById('themeEditor').hidden")) === true);
    await evalJs("toggleThemeEditor()");
    await sleep(200);
    const swatchCount = await evalJs("document.querySelectorAll('#themeEditor .te-chip').length");
    ck('展开后有取色色块', swatchCount > 30, `count=${swatchCount}`);
    const groups = ['teBg', 'teSurface', 'teText', 'teAccent', 'teLog', 'teTerm', 'teDoc', 'teMisc'];
    const groupOk = await evalJs(`[${groups.map((g) => `document.getElementById('${g}').children.length`).join(',')}]`);
    ck('八个分组都填了色块', Array.isArray(groupOk) && groupOk.every((n) => n > 0), JSON.stringify(groupOk));

    // 色块尺寸: 不能被全局 input{width:100%} 拉成横条
    const chipBox = await evalJs(`(() => {
      const el = document.getElementById('te_acc');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor };
    })()`);
    ck('色块是 26x22 的小方块', chipBox.w === 26 && chipBox.h === 22, JSON.stringify(chipBox));
    ck('色块涂上了主色', /63,\s*211,\s*198/.test(chipBox.bg), chipBox.bg);

    // 3) 点色块弹出取色面板 (v1.5.4: 以前只能开系统取色器, 现在有站内面板)
    ck('取色面板默认是收起的', (await evalJs("document.getElementById('cpPop').hidden")) === true);
    await evalJs("document.getElementById('tr_acc').click()");
    await sleep(250);
    ck('点色块把面板打开了', (await evalJs("document.getElementById('cpPop').hidden")) === false);
    const cpTitle = await evalJs("document.getElementById('cpTitle').textContent");
    ck('面板标题是「主色」', cpTitle === '主色', cpTitle);
    ck('面板上写着变量名 --acc', (await evalJs("document.getElementById('cpVar').textContent")) === '--acc');

    const cpCounts = await evalJs(`({
      common: document.getElementById('cpCommon').children.length,
      shades: document.getElementById('cpShades').children.length,
      hues: document.getElementById('cpHues').children.length,
    })`);
    ck('三组预设色块都填满了',
      cpCounts.common > 20 && cpCounts.shades >= 8 && cpCounts.hues > 24,
      JSON.stringify(cpCounts));

    // 面板不能跑到屏幕外面
    const cpBox = await evalJs(`(() => {
      const r = document.getElementById('cpPop').getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
               vw: innerWidth, vh: innerHeight };
    })()`);
    ck('面板完整落在视口内',
      cpBox.x >= 0 && cpBox.y >= 0 && cpBox.x + cpBox.w <= cpBox.vw + 1 && cpBox.y + cpBox.h <= cpBox.vh + 1,
      JSON.stringify(cpBox));

    // 输入色码 -> 实时上色
    await evalJs(`(() => {
      const el = document.getElementById('cpHex');
      el.value = '#ff7a29';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(250);
    const typed = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()");
    ck('输入色码实时生效', typed.toLowerCase() === '#ff7a29', typed);

    // 同色调条跟着重算(不能还留着上一个色系的色块): 最亮那档应该是"偏红"的白
    const shadeRgb = await evalJs(`(() => {
      const el = document.getElementById('cpShades').children[0];
      const m = getComputedStyle(el).backgroundColor.match(/\\d+/g).map(Number);
      return m;
    })()`);
    ck('同色调条跟着新颜色重算',
      Array.isArray(shadeRgb) && shadeRgb[0] > 245 && shadeRgb[2] < shadeRgb[0],
      JSON.stringify(shadeRgb));

    // 乱敲几个字 -> 标红但不清空、不改色
    await evalJs(`(() => {
      const el = document.getElementById('cpHex');
      el.value = 'zzz';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await sleep(200);
    ck('乱敲的色码被标红', (await evalJs("document.getElementById('cpHex').classList.contains('bad')")) === true);
    ck('乱敲的色码没把颜色搞坏',
      (await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()")).toLowerCase() === '#ff7a29');

    // 点一个预设色块直接生效
    await evalJs(`(() => {
      const el = document.querySelector('#cpCommon .cp-sw[data-color="#3fd3c6"]');
      if (el) el.click();
    })()`);
    await sleep(250);
    ck('点预设色块直接上色',
      (await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()")).toLowerCase() === '#3fd3c6');

    // Esc 关掉面板
    await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    await sleep(200);
    ck('Esc 能关掉取色面板', (await evalJs("document.getElementById('cpPop').hidden")) === true);

    // 4) 背景色项可用(它是 rgba 派生变量的源头, 必须能改)
    ck('背景底色那一项存在', (await evalJs("!!document.getElementById('te_bg')")) === true);

    // 4) 换主色 -> 页面上的主色真的变了
    const before = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()");
    await evalJs("setThemeVar('acc', '#ff0055')");
    await sleep(150);
    const after = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()");
    ck('主色改得动', before.toLowerCase() !== after.toLowerCase(), `${before} -> ${after}`);
    ck('改成的是 #ff0055', after.toLowerCase() === '#ff0055', after);

    // 5) 焦点圈跟着主色走(之前写死青色的老毛病)
    const ring = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc-a22').trim()");
    ck('焦点圈跟着主色重算', /255,\s*0,\s*85/.test(ring), ring);

    // 6) 改了之后自动变成「自定义」
    const selCount = await evalJs("document.querySelectorAll('#themeSwatches .theme-sw').length");
    ck('多出一个「自定义」色块', selCount === 8, `count=${selCount}`);
    ck('自定义被选中', (await evalJs(
      "document.querySelectorAll('#themeSwatches .theme-sw.sel')[0].title",
    )) === '自定义');

    // 7) 存盘: config.json 里已经有值
    const st = await (await fetch(`${base}/api/state`)).json();
    ck('配色已存进 config', st.ui && st.ui.theme && st.ui.theme.preset === 7, JSON.stringify(st.ui));

    // 8) 刷新页面后还在
    await client.send('Page.reload');
    await sleep(1600);
    const afterReload = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()");
    ck('刷新后主色还是自定义的', afterReload.toLowerCase() === '#ff0055', afterReload);

    // 9) 点回预设 -> 回到深海青
    await evalJs("applyTheme(0)");
    await sleep(200);
    const back = await evalJs("getComputedStyle(document.documentElement).getPropertyValue('--acc').trim()");
    ck('点回预设能恢复', back.toLowerCase() === '#3fd3c6', back);

    // 10) 鲸鱼娘形象: 内联 symbol 在页面里, 顶栏头像和空状态都在用它
    ck('鲸鱼娘 symbol 已内联', (await evalJs("!!document.getElementById('whaleGirl')")) === true);
    const ava = await evalJs(`(() => {
      const r = document.querySelector('header .whale-ava').getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    ck('顶栏头像 26x26 的圆形', ava.w === 26 && ava.h === 26, JSON.stringify(ava));
    ck('顶栏头像用 <use> 引 symbol',
      (await evalJs("document.querySelector('header .whale-ava use').getAttribute('href')")) === '#whaleGirl');
    ck('空状态里有鲸鱼娘水印', (await evalJs("document.querySelectorAll('.whale-empty').length")) >= 1);
    // 全部渐变 id 都带 wh- 前缀, 不会和页面别的 svg 撞名
    const badIds = await evalJs(`(() => {
      const ids = [...document.querySelectorAll('#whaleGirl [id]')].map((e) => e.id);
      return ids.filter((i) => !i.startsWith('wh-'));
    })()`);
    ck('渐变 id 全部加了 wh- 前缀', Array.isArray(badIds) && badIds.length === 0, JSON.stringify(badIds));

    // 11) 页面无 JS 报错
    const errs = await evalJs('window.__jsErrors || []');
    ck('页面没有 JS 报错', Array.isArray(errs) && errs.length === 0, JSON.stringify(errs));
  } finally {
    try { client && client.close(); } catch { /* ignore */ }
    if (edgePid) killTree(edgePid);
    // profile 必须单独删: 上面只杀进程, 句柄还占着 -> 要带重试
    removeProfile(edgeProfile);
    try { server.kill(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(path.join(ROOT, '_testrun', `theme-ui-${process.pid}`), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().then(() => {
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}  ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('测试崩了:', e);
  process.exit(1);
});
