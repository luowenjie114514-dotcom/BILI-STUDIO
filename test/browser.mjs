/**
 * UI 测试共用的 Edge 启动/收尾工具（v1.6.0 新增）。
 *
 * 为什么要单独抽出来：
 *   以前四个 UI 测试的收尾都是一句
 *     execSync('taskkill /F /IM msedge.exe /T')
 *   按**镜像名**杀进程 —— 这会连主人正在用的那块浏览器一起关掉。
 *   正确做法是只收自己拉起来的那个进程树：知道它的 pid，就让 tree-kill 只杀它。
 *
 * 另外顺手统一三件事：
 *   1. 每个测试用**自己独立的** --user-data-dir，跑完删掉，不碰默认 Profile；
 *   2. 调试端口用系统分配，避免四个测试撞 9222；
 *   3. 启动前先把残留的测试 Profile 目录清掉，避免 "user data dir is already in use"。
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

export const EDGE_PATH = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

/** 让系统分配一个空闲端口（测试默认抢 9222 会互撞） */
export function freePort() {
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

/**
 * 起一个 headless Edge。
 * @param {object} opts
 * @param {string} opts.name  测试名, 用来区分 profile 目录
 * @param {number} opts.port  调试端口（不传就自己找）
 * @returns {Promise<{child, port, profile, close}>{...}}
 */
export async function launchEdge({ name = 'ui', port, extraArgs = [] } = {}) {
  if (!EDGE_PATH) throw new Error('找不到 msedge.exe');
  const dbg = port || await freePort();
  // profile 放在项目内的 _testrun 里: %TEMP% 在沙箱下写不了
  const profile = path.join(ROOT, '_testrun', `edge-${name}-${process.pid}`);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  const child = spawn(EDGE_PATH, [
    '--headless=new',
    `--remote-debugging-port=${dbg}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1470,905',
    ...extraArgs,
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  return {
    child,
    port: dbg,
    profile,
    /** 只收这一棵树, 不碰主人自己的浏览器 */
    close() {
      killTree(child.pid);
      // 必须用带重试的删法: killTree 刚返回时句柄还占着, 裸 rmSync 会静默失败,
      // 于是 _testrun/edge-xxx-<pid> 就留在项目里了(每个 ~55MB)
      removeProfile(profile);
    },
  };
}

/**
 * 按 PID 杀掉整个进程树。
 * Windows 用 `taskkill /PID <pid> /T /F` —— /T 是「连同子进程」, /F 是强制,
 * 关键是给了 /PID, 所以只命中这一棵树, 不会波及别的浏览器。
 */
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* 进程早就没了 */ }
}

/** 轮询 CDP 的 /json/version 直到浏览器可用 */
export async function waitForDevtools(port, { tries = 80, gap = 150 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return await r.json();
    } catch { /* 还没起来 */ }
    await new Promise((res) => setTimeout(res, gap));
  }
  throw new Error(`Edge 的调试端口 ${port} 在 ${tries * gap}ms 内没起来`);
}

/** 兜底: 进程退出/异常时也别把浏览器留在后台 */
export function autoCleanup(handle) {
  const bye = () => { try { handle.close(); } catch { /* ignore */ } };
  process.on('exit', bye);
  process.on('SIGINT', () => { bye(); process.exit(130); });
  process.on('uncaughtException', (e) => { bye(); console.error(e); process.exit(1); });
}

/**
 * 删掉一个 Edge profile 目录, 删不掉就等一下再试。
 *
 * 为什么要重试: `killTree()` 返回的时候进程还没完全退干净, 文件句柄仍被占着,
 * 立刻 `rm -rf` 在 Windows 上会抛 EBUSY/EPERM —— 以前四个老测试就是漏了这一步,
 * 每个都留下一个 **55 MB** 的 `.edge-xxx-profile` 目录, 堆到项目里没人管。
 *
 * 用同步等待(Atomics.wait)而不是 setTimeout: 调用方常常紧跟一句
 * `process.exit()`, 异步重试的定时器根本来不及跑。
 */
export function removeProfile(dir, { tries = 6, gap = 200 } = {}) {
  if (!dir) return;
  const sleepSync = (ms) => {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 主线程不允许就跳过 */ }
  };
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(gap);
    }
  }
}
