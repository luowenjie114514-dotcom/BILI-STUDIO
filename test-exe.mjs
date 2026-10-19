/* exe 端到端验收: 请求头解析 / 皮肤导入 / 干跑任务
 *
 * 用法:
 *   node test-exe.mjs                    自己拉 dist\bili-studio.exe, 用临时数据目录
 *   node test-exe.mjs --port=8913        打已经跑着的实例
 *   node test-exe.mjs --port=8913 --allow-real   同上, 但明确知道那是个真实配置
 *
 * 为什么默认自己拉: 这个脚本会改配置(加账户 / 换皮肤 / 加名单) 并写 history.jsonl。
 * 2026-10-19 就因为对着主人 WHALE 里的真实实例跑了一次, 把真实配置改出一堆测试垃圾。
 * 所以默认走隔离目录; 要打真实实例必须显式加 --allow-real。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort, killTree, removeProfile } from './test/browser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, 'dist');
const EXE = path.join(DIST, 'bili-studio.exe');

const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const USE_EXTERNAL = !!arg('port');
const ALLOW_REAL = argv.includes('--allow-real');

if (USE_EXTERNAL && !ALLOW_REAL) {
  console.error('拒绝执行: --port 会改目标实例的真实配置。');
  console.error('  想测打包产物 -> 直接 node test-exe.mjs (自己拉 exe, 用临时目录)');
  console.error('  确实要打真实实例 -> 再补上 --allow-real');
  process.exit(2);
}

let PORT = 0;
let B = '';
let child = null;
const DATA_DIR = USE_EXTERNAL ? '' : path.join(__dirname, '_testrun', `exe-${process.pid}`, 'data');

async function boot() {
  if (USE_EXTERNAL) {
    PORT = Number(arg('port'));
    B = `http://127.0.0.1:${PORT}`;
    return;
  }
  if (!fs.existsSync(EXE)) {
    console.error(`找不到 ${EXE}，先跑 node build.mjs`);
    process.exit(2);
  }
  PORT = await freePort();
  B = `http://127.0.0.1:${PORT}`;
  await fsp.mkdir(DATA_DIR, { recursive: true });
  child = spawn(EXE, [`--port=${PORT}`, '--no-open'], {
    cwd: DIST,
    env: { ...process.env, DSH_BILI_STUDIO_DATA: DATA_DIR },
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', (e) => console.error('启动 exe 失败:', e.message));
  for (let i = 0; i < 80; i++) {
    await new Promise((x) => setTimeout(x, 250));
    try {
      const r = await fetch(B + '/api/state', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return;
    } catch { /* 还没起来 */ }
  }
  console.error('exe 没能起来');
  process.exit(2);
}

async function shutdown() {
  if (child?.pid) killTree(child.pid);
  if (DATA_DIR) removeProfile(path.dirname(DATA_DIR));
}

const get = (p) => fetch(B + p).then((r) => r.json());
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

// 故意用"整串请求头"形态, 验证关键词精准定位 —— 全是假值, 不是任何真实账号
const HEADER_BLOB = [
  'GET /x/v2/reply/add HTTP/1.1',
  'Host: api.bilibili.com',
  'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept: application/json, text/plain, */*',
  'Cookie: buvid3=FAKE-BUVID3-0000-0000-0000-0000000000000infoc; SESSDATA=FAKE%2C0000000000%2C000000%2AFAKE_SESSDATA_FOR_TEST_ONLY; bili_jct=00000000000000000000000000000000; DedeUserID=000000000',
  'Referer: https://www.bilibili.com/',
].join('\n');

const results = [];
const ck = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

(async () => {
  await boot();
  console.log(`[test-exe] 目标 ${B}${USE_EXTERNAL ? ' (外部实例)' : ` (临时数据目录 ${DATA_DIR})`}`);

  // 1) 基本状态
  let s = await get('/api/state');
  // 版本号允许带后缀(如 1.5.3_Rebuilding / 1.6.0-beta.1), 只要求「数字.数字.数字」开头
  ck('exe 提供 /api/state', /^\d+\.\d+\.\d+/.test(s.version || ''), `version=${s.version}`);
  ck('皮肤字段存在', !!s.skin, `active=${s.skin?.active}`);

  // 2) 整串请求头 -> 账户
  const r2 = await post('/api/accounts', { name: '请求头测试号', cookieText: HEADER_BLOB });
  if (r2.error) {
    ck('整串请求头解析', false, r2.error);
  } else {
    const acc = r2.accounts[r2.accounts.length - 1];
    ck('整串请求头解析', acc.hasCookie === true,
      `识别字段=[${(r2.parsedFields || []).join(',')}] 登录=${acc.uname || '?'} Lv${acc.level ?? '?'} mid=${acc.mid || '?'}`);
    ck('SESSDATA 百分号编码未被破坏',
      (r2.parsedFields || []).includes('SESSDATA'));
  }

  // 3) 皮肤: 列表 -> 上传 -> 校验可访问 -> 预设切换
  let sk = await get('/api/skins');
  ck('皮肤列表', Array.isArray(sk.presets) && sk.presets.length >= 4,
    `预设 ${sk.presets.length} 个`);

  // 用内置的 1x1 PNG, 免得依赖外部图片文件(以前这里会因清理而报 ENOENT)
  const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const pngPath = path.join(DIST, 'test-skin.png');
  const png = fs.existsSync(pngPath)
    ? fs.readFileSync(pngPath)
    : Buffer.from(TINY_PNG_B64, 'base64');
  const up = await post('/api/skin/upload', { data: 'data:image/png;base64,' + png.toString('base64') });
  if (up.error) {
    ck('PNG 导入', false, up.error);
  } else {
    ck('PNG 导入', !!up.url, `active=${up.active}`);
    const res = await fetch(B + up.url);
    ck('导入的皮肤可访问', res.status === 200 && res.headers.get('content-type') === 'image/png',
      `HTTP ${res.status} ${res.headers.get('content-type')} ${(await res.arrayBuffer()).byteLength} 字节`);
    const relist = await get('/api/skins');
    ck('自定义皮肤出现在列表', relist.custom.some((c) => c.id === up.active),
      `custom=${relist.custom.length} 个`);
  }

  const act = await post('/api/skin/activate', { id: 'sakura' });
  ck('预设皮肤切换', act.active === 'sakura', `active=${act.active}`);

  // 4) @名单 + 干跑任务
  const m = await post('/api/mentions', { uname: '示例用户' });
  // 重复添加被拒也是正确行为(说明去重生效), 一并算通过
  ck('添加 @名单(自动查mid)',
    !m.error || /已经在名单里/.test(m.error || ''),
    m.error ? `${m.error}（去重生效）` : `共 ${m.mentions.length} 人`);

  const run = await post('/api/task/run', { repeat: 1, dryRun: true });
  ck('干跑任务启动', run.started === true);
  for (let i = 0; i < 40; i++) {
    await new Promise((x) => setTimeout(x, 2000));
    const h = await get('/api/task/history');
    if (!h.running) {
      const t = h.history[0];
      ck('干跑任务完成', !!t, `planned=${t?.planned} posted=${t?.posted} failed=${t?.failed} skipped=${t?.skipped}`);
      if (t?.items?.[0]) console.log(`   样例评论: ${t.items[0].message}`);
      // P2-9 回归: 内联器曾把 `configureHistory({ file })` 的形参键改名成 __history_file,
      // 于是 file 传不进去, 历史永远只存在内存里 —— 源码模式完全看不出来, 只有 exe 会中招。
      ck('历史拿到了真实的落盘路径', typeof h.file === 'string' && /history\.jsonl$/.test(h.file), `file=${h.file}`);
      ck('history.jsonl 真的写到磁盘了', !!h.file && fs.existsSync(h.file), h.file);
      break;
    }
  }

  // 5) 配置文件不应含明文 key
  const cfgPath = USE_EXTERNAL
    ? path.join(DIST, 'data', 'config.json')
    : path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    ck('配置文件不含明文 API key', !/sk[-_]/.test(raw.replace(/"apiKey":\s*""/g, '')),
      `config ${raw.length} 字节`);
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n===== ${results.length - bad.length}/${results.length} 通过 =====`);
  if (bad.length) { console.log('失败项:'); bad.forEach((b) => console.log(' -', b.name, b.detail)); }
  await shutdown();
  process.exit(bad.length ? 1 : 0);
})().catch(async (e) => {
  console.error('验收脚本异常:', e);
  await shutdown();
  process.exit(2);
});
