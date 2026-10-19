#!/usr/bin/env node
/**
 * 鲸鱼娘 · B站养史控制台  (bili-studio)
 * ------------------------------------------------------------------
 * 本机运行的 B 站"找人 @ + 发评论"任务台。
 *
 *   启动:  node server.mjs        然后浏览器打开 http://127.0.0.1:8787
 *
 * 能力:
 *   - 账户管理: 存多套 cookie(SESSDATA/bili_jct/buvid3), 一键测活
 *   - @ 名单管理: 想 @ 谁就加谁(自动查 mid)
 *   - 内容偏好: 用自然语言描述想搬什么样的史, 交给 DeepSeek 变成搜索关键词
 *   - 立即执行: 按下就跑一次(可设跑几条视频)
 *   - 自动任务: 周期计时(每N分钟) 或 闹钟模式(某日某时)
 *   - 问候语风格: 同样是自然语言描述, DeepSeek 照着风格写评论
 *   - 署名: 自动加 "——署名"
 *
 * 安全设计:
 *   - 默认 dryRun = true, 只预览不发, 主人要主动关掉才会真的发
 *   - 只监听 127.0.0.1, 外网摸不到
 *   - cookie 只存在本机 data/config.json, 不上传任何第三方
 *   - 每条之间强制间隔 + 每日上限, 降低风控概率
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 静态资源在打包 exe 时内嵌进 JS(build.mjs 生成 embed-assets.mjs);
// 开发模式 embed-assets.mjs 内容为空, 回退到磁盘 public/ 目录。
import { EMBED } from './embed-assets.mjs';

// 纯工具层(v1.6.0 起拆分): 网络/配置无关的小函数
import {
  sleep, BV_RE, decodeEntities, parseBvid, countChars, clipChars, deepMerge,
} from './server/util.mjs';

// B 站 API 层(v1.6.0 起拆分): cookie 解析 / 搜索 / 稿件 / 评论, 不含业务编排
import {
  configureBili, reqJSON, COOKIE_KEYS, parseCredentialText, biliCookie, biliNav,
  biliUserSearch, biliVideoSearch, normalizePic, biliVideoInfo, biliPostComment,
  REPLY_ERRORS,
} from './server/bili.mjs';

// AI 层(v1.6.0 起拆分): OpenAI 兼容接口的请求/重试/错误翻译
import {
  setAiContext, normalizeBaseUrl, resolveAiRequest, extractErrMessage,
  describeAiError, extractJsonObject, dsChat, aiState,
} from './server/ai.mjs';

// 私信层(v1.6.0 起拆分): 发私信 / 分享卡片 / 卡片降级文字
import {
  configureDm, DM_ERRORS, biliSendMsg, videoUrlOf, buildShareCard, sendDm, dmErrorText,
} from './server/dm.mjs';

// 内容生成层(v1.6.0 起拆分): 偏好分析 / 评论正文 / 私信正文 / 兜底模板
import {
  configureWriter, dsAnalyzePreference, dsWriteGreeting, localGreeting,
  dmCharLimit, dsWriteDmGreeting, localDmGreeting, pickCarrierVideo, dmFormNow,
} from './server/writer.mjs';

// 配置迁移链(v1.6.0 起拆分): schemaVersion + 逐版升级, 避免字段改名时静默丢值
import { SCHEMA_VERSION, MIGRATIONS, migrateConfigChain } from './server/configmigrate.mjs';

// 任务历史落盘(v1.5.3 起拆分): 追加写 data/history.jsonl, 重启不丢
import {
  configureHistory, loadHistory, appendHistory, recentHistory, clearHistory, historyFilePath,
} from './server/history.mjs';

// 目录基准: 开发模式是 server.mjs 所在目录; 打包成 exe 后是 exe 所在目录。
// 三种运行形态都要兼容:
//   - node server.mjs   (ESM, import.meta.url 可用)
//   - SEA 打包的 exe     (CJS, __dirname 指向 exe 所在目录)
function resolveBaseDir() {
  try {
    if (typeof __dirname === 'string' && __dirname && fs.existsSync(__dirname)) return __dirname;
  } catch { /* 非 CJS 环境, 忽略 */ }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    if (here && here !== '.' && fs.existsSync(here)) return here;
  } catch { /* fallthrough */ }
  return path.dirname(process.execPath);
}

const __baseDir = resolveBaseDir();

const VERSION = '1.5.4';

const DATA_DIR = process.env.DSH_BILI_STUDIO_DATA
  || path.join(__baseDir, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PUBLIC_DIR = path.join(__baseDir, 'public');
const SKINS_DIR = path.join(DATA_DIR, 'skins');
const LOG_FILE = path.join(DATA_DIR, 'exe.log');
const ERR_PAGE = path.join(DATA_DIR, 'startup-error.html');

// 是不是打包后的 exe(node.exe 以外都算)。打包版默认自动开浏览器,
// 源码版不自动开(否则和 start.ps1 抢着开, 会开出两个标签页)。
const IS_PACKAGED = !/^node(\.exe)?$/i.test(path.basename(process.execPath));

/**
 * 取更新日志正文。源码模式读项目根的 CHANGELOG.md(改完刷新就能看到),
 * 打包 exe 用 build.mjs 内嵌进去的那份(见 build.mjs 的 ROOT_ASSETS)。
 */
async function readChangelog() {
  if (!IS_PACKAGED) {
    try {
      return await fsp.readFile(path.join(__baseDir, 'CHANGELOG.md'), 'utf8');
    } catch { /* 落到内嵌 */ }
  }
  return (EMBED && EMBED['CHANGELOG.md']) || '';
}

// 端口必须可被命令行覆盖, 所以是 let: 早期版本写成 const,
// 导致 --port= 参数在模块加载后赋值、永远不生效。
let PORT = Number(process.env.PORT || 8787);
const HOST = '127.0.0.1';

/** 是否自动打开浏览器: exe 默认开, 源码默认关, 命令行可覆盖 */
let AUTO_OPEN = IS_PACKAGED;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 把 UA 交给 B 站 API 层, 这一层就不再依赖 server.mjs 的常量
configureBili({ UA });

/* ------------------------------------------------------------------ */
/* 配置                                                               */
/* ------------------------------------------------------------------ */

const DEFAULT_CONFIG = {
  schemaVersion: SCHEMA_VERSION,   // 配置结构版本, 见 server/config-migrate.mjs
  port: PORT,
  accounts: [],
  activeAccountId: '',
  mentions: [],
  contentPreference: '无厘头搞笑、抽象、面向年轻人的下饭消遣视频，播放量高、评论区活跃',
  stylePreference: '暖一点，像小鲸鱼撒娇，简短自然，不要书面语',
  keywords: [],                 // DS 分析出来并缓存的关键词, 点一次分析就存下来
  analysis: null,               // 上次分析的完整结果
  signature: '笨蛋鲸鱼娘',
  ds: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    authMode: 'bearer',        // bearer | api-key | x-api-key | none
    endpoint: '',              // 填了就完全覆盖请求地址(支持带查询串, 如 Azure)
    extraHeaders: '',          // 额外请求头, 每行 "Name: value"
    apiKeyRef: 'DEEPSEEK_API_KEY',  // 从 DSH 凭据/环境变量里读哪个名字的 key
  },
  task: {
    dryRun: true,
    videoSource: 'search',      // search | manual
    manualBvids: '',
    videosPerRun: 3,
    delaySeconds: 12,
    dailyLimit: 10,
    searchPages: 2,
    // 私信模式: 勾上就不在评论区发言, 改成给 @ 名单里的人发私信
    dm: false,
    dmForm: 'card',             // card = 原生视频分享卡片(被拒自动降级文字) | texturl = 纯文字 + 视频链接
    dmTitle: true,              // 私信里带不带视频标题(卡片形态下 = 卡片标题用视频真名)
    dmMaxChars: 40,             // 私信正文字数上限(不含 @昵称和署名), 超了自动截
  },
  schedules: [],
  stats: { date: '', postedToday: 0 },
  skin: { active: 'default' },       // 皮肤: default | ocean | sakura | dark | custom:<file>
  // 主题配色(v1.5.4): 前端负责定义有哪些变量, 这里只存档 —— { preset, custom }
  //   preset: 0..N 是预设主题下标, N 表示用下面 custom 那套自定义颜色
  //   放在 config.json 里而不是只放 localStorage: 换端口/换浏览器时配色不丢
  ui: { theme: null },
};

let config = structuredClone(DEFAULT_CONFIG);
let running = false;
let runAbort = false;
/** DeepSeek key 只活在内存里, 绝不写进 config.json */
let dsKeyMem = '';
let dsKeySource = '未配置';
/** 本进程启动时执行过的配置迁移(给前端状态栏看), 没迁移就是 null */
let lastMigration = null;

// AI 层不直接读全局变量, 这里把「怎么拿配置 / 怎么拿 key / 怎么打日志」注入过去
setAiContext({
  getDs: () => config.ds || {},
  getKey: () => dsKeyMem,
  log: (level, msg) => log(level, msg),
});

// 私信层同样需要一只日志笔
configureDm({ log: (level, msg) => log(level, msg) });

// 内容生成层要读配置(风格/字数/视频来源), 也要能打日志
configureWriter({ getConfig: () => config, log: (level, msg) => log(level, msg) });

// 任务历史落盘: 先把文件位置和日志笔给它, 启动时再 loadHistory() 读回内存
configureHistory({ file: path.join(DATA_DIR, 'history.jsonl'), log: (level, msg) => log(level, msg) });

async function loadConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  let parseFailed = false;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const text = await fsp.readFile(CONFIG_FILE, 'utf8');
      let raw;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        // 单独包一层, 好把"文件语法坏了"和"合并逻辑坏了"区分开
        throw new Error(`JSON 语法错误: ${e.message}`);
      }
      config = deepMerge(structuredClone(DEFAULT_CONFIG), raw);
      // 迁移链: 老文件没有 schemaVersion 就当 v0, 一步步升到当前版本。
      // 必须把「磁盘上写的版本」显式传进去 —— deepMerge 已经从 DEFAULT_CONFIG
      // 把当前版本号填好了, 直接读 config.schemaVersion 会让迁移链以为不用迁移。
      const storedVer = Number(raw && raw.schemaVersion);
      const mig = migrateConfigChain(config, {
        log,
        fromVersion: Number.isFinite(storedVer) ? storedVer : 0,
      });
      config = mig.config;
      if (mig.applied.length) {
        lastMigration = { from: mig.from, to: mig.to, steps: mig.applied };
        log('ok', `配置已从 v${mig.from} 迁移到 v${mig.to}（${mig.applied.length} 步）`);
      }
    } catch (e) {
      parseFailed = true;
      // 关键: 解析失败时绝不覆盖原文件, 先备份再从默认值跑, 免得把主人的数据洗掉
      const bak = `${CONFIG_FILE}.broken-${Date.now()}`;
      try { await fsp.copyFile(CONFIG_FILE, bak); } catch { /* ignore */ }
      log('error', `配置文件加载失败: ${e.message}`);
      log('warn', `原文件已备份到 ${path.basename(bak)}, 本次用默认配置运行(不会写回覆盖)`);
      config = structuredClone(DEFAULT_CONFIG);
    }
  }
  // 兼容早期版本: 如果文件里存过 key, 读进内存后立刻从文件抹掉
  if (config.ds.apiKey) {
    dsKeyMem = config.ds.apiKey.trim();
    dsKeySource = '配置文件(已迁移到内存)';
    config.ds.apiKey = '';
    log('warn', '检测到 API key 曾以明文存在配置文件里, 已读入内存并从文件删除');
  }
  if (!dsKeyMem) {
    const found = findDsKey();
    dsKeyMem = found.key;
    dsKeySource = found.source;
  }
  rollStats();
  if (!parseFailed) await saveConfig();
}

/**
 * 解析 DSH 凭据文件里的 refs 段。
 * 只认 UPPER_SNAKE_CASE 的键，这样能避开 records 段里的 token/secret/id 之类。
 */
function readCredentialRefs() {
  const out = {};
  const candidates = [
    path.join(os.homedir(), '.dsh', '.credentials.yaml'),
    path.join(process.env.DSH_HOME || '', '.credentials.yaml'),
  ].filter((p) => p && fs.existsSync(p));
  for (const file of candidates) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      for (const m of txt.matchAll(/^\s{0,4}([A-Z][A-Z0-9_]{2,}):\s*(\S+)\s*$/gm)) {
        if (!(m[1] in out)) out[m[1]] = { value: m[2], file };
      }
    } catch { /* 读不到就算了 */ }
  }
  return out;
}

/**
 * 找 API Key。优先级：
 *   1. 环境变量（名字 = config.ds.apiKeyRef）
 *   2. 凭据文件 refs 段里的同名条目
 *   3. 按 Base URL 猜一个常见凭据名（opc.fiime -> OPCFIIME_API_KEY 等）
 * 这样主人只需在界面里填一次"凭据名"，之后重启 exe 会自动读回来，不用反复粘 Key。
 */
function findDsKey() {
  const ref = (config.ds?.apiKeyRef || 'DEEPSEEK_API_KEY').trim() || 'DEEPSEEK_API_KEY';

  if (process.env[ref]) {
    return { key: process.env[ref].trim(), source: `环境变量 ${ref}` };
  }

  const refs = readCredentialRefs();
  if (refs[ref]) {
    return { key: refs[ref].value, source: `DSH 凭据 ${ref}` };
  }

  // 兜底：根据 Base URL 猜这家该用哪个凭据名
  const host = String(config.ds?.baseUrl || '').toLowerCase();
  const guess = host.includes('opc.fiime') ? 'OPCFIIME_API_KEY'
    : host.includes('moonshot') ? 'MOONSHOT_API_KEY'
      : host.includes('openai.com') ? 'OPENAI_API_KEY'
        : host.includes('siliconflow') ? 'SILICONFLOW_API_KEY'
          : host.includes('deepseek') ? 'DEEPSEEK_API_KEY'
            : '';
  if (guess && refs[guess]) {
    return { key: refs[guess].value, source: `DSH 凭据 ${guess}（按 Base URL 自动匹配）` };
  }

  const available = Object.keys(refs).filter((k) => /_API_KEY$/.test(k));
  return {
    key: '',
    source: available.length
      ? `未配置（凭据文件里可用的是：${available.join('、')}）`
      : '未配置',
  };
}

async function saveConfig() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(config, null, 2), 'utf8');
  await fsp.rename(tmp, CONFIG_FILE);
}

/**
 * 递归合并。三个必须容忍的坑(都踩过):
 *   1. patch 为 null/undefined  -> 保留 base
 *   2. 数组                    -> 直接整体替换, 不逐项合并
 *   3. base 为 null 而 patch 是对象 -> 必须整体取 patch。
 *      注意 typeof null === 'object', 所以只判断 typeof 会放行 null,
 *      后面 hasOwnProperty.call(null, k) 会抛 "Cannot convert undefined or null to object"。
 */

function rollStats() {
  // 用本地日期, 不用 UTC —— 否则北京时间凌晨不会正确跨天
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (config.stats.date !== today) {
    config.stats = { date: today, postedToday: 0 };
  }
}

/* ------------------------------------------------------------------ */
/* 日志(环形缓冲, 前端轮询拉取)                                        */
/* ------------------------------------------------------------------ */

const LOGS = [];
let logSeq = 0;
let fileLogReady = false;

/**
 * 同时把日志写一份到 data/exe.log。
 * 打包成 GUI 子系统后进程没有控制台, console.log 的输出会消失,
 * 所以文件是唯一可靠的落档方式(网页里的日志台是内存态, 重启就没了)。
 */
function fileLog(line) {
  try {
    if (!fileLogReady) { fs.mkdirSync(DATA_DIR, { recursive: true }); fileLogReady = true; }
    try {
      if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* 文件还不存在, 正常 */ }
    fs.appendFileSync(LOG_FILE, `${line}\n`, 'utf8');
  } catch { /* 磁盘写不了也不能影响主流程 */ }
}

function log(level, message, extra) {
  const entry = {
    seq: ++logSeq,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level,
    message,
    extra: extra === undefined ? null : extra,
  };
  LOGS.push(entry);
  if (LOGS.length > 600) LOGS.splice(0, LOGS.length - 600);
  const tag = { info: '  ', ok: 'OK', warn: '!!', error: 'XX', step: '->' }[level] || '  ';
  const line = `[${entry.time}] ${tag} ${message}`;
  console.log(line);
  fileLog(line);
  return entry;
}

/** 命令行输出: 打包成 GUI 子系统后没有控制台, 输出会静默消失, 所以留一份到文件 */
function emitCli(text) {
  try { console.log(text); } catch { /* 无控制台 */ }
  if (!IS_PACKAGED) return;   // 源码模式有控制台, 不用另存
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'cli-output.txt'), `${text}\n`, 'utf8');
  } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 站内终端: 抓进程自己的输出 + 在项目目录跑命令                        */
/* ------------------------------------------------------------------ */

const TERM = {
  buf: [],
  seq: 0,
  max: 1500,
  cwd: __baseDir,
  child: null,
  execSeq: 0,
};

function termPush(stream, text) {
  const t = text === undefined || text === null ? '' : String(text);
  if (!t) return;
  for (const line of t.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) continue;
    TERM.buf.push({
      seq: ++TERM.seq,
      stream,
      text: line.length > 4000 ? `${line.slice(0, 4000)} …(截断)` : line,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    });
  }
  if (TERM.buf.length > TERM.max) TERM.buf.splice(0, TERM.buf.length - TERM.max);
}

// 把进程自己的 stdout/stderr 接进终端。打包成 GUI 子系统后没有黑窗口,
// 这是唯一能看到服务端输出的地方(比翻 data/exe.log 方便)。
try {
  for (const [name, tag] of [['stdout', 'out'], ['stderr', 'err']]) {
    const stream = process[name];
    if (!stream || typeof stream.write !== 'function') continue;
    const orig = stream.write.bind(stream);
    stream.write = function patchedWrite(chunk, enc, cb) {
      try {
        termPush(tag, typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      } catch { /* 记不下就算了, 不能挡住真正的输出 */ }
      try { return orig(chunk, enc, cb); } catch { return true; }
    };
  }
} catch { /* 极端环境下拿不到 stdout, 忽略 */ }

function termExec(input) {
  const line = String(input || '').trim();
  if (!line) throw new Error('命令是空的');
  if (TERM.child) throw new Error('上一条还在跑，先点「■ 停止」');
  termPush('in', `> ${line}`);

  // cd 单独处理: 每条命令是独立进程, 只能我们自己记住当前目录
  const cd = line.match(/^(?:cd|chdir)(?:\s+(.*))?$/i);
  if (cd) {
    const raw = (cd[1] || '').trim().replace(/^["']|["']$/g, '');
    const target = raw ? path.resolve(TERM.cwd, raw) : __baseDir;
    if (!fs.existsSync(target)) {
      termPush('err', `目录不存在: ${target}`);
      return { ok: false, cwd: TERM.cwd };
    }
    TERM.cwd = target;
    termPush('sys', `→ ${TERM.cwd}`);
    return { ok: true, cwd: TERM.cwd };
  }

  let child;
  try {
    // Windows 的 cmd 内建命令(dir/copy/cls/中文报错)用的是控制台 OEM 代码页(简体中文 GBK),
    // 不是 UTF-8, 所以子进程输出先按 binary 收, 再逐行判断是 UTF-8 还是 GBK。
    const isWin = process.platform === 'win32';
    const cmdLine = isWin ? `chcp 65001>nul & ${line}` : line;
    const env = isWin ? { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } : process.env;
    child = spawn(cmdLine, { shell: true, cwd: TERM.cwd, windowsHide: true, env });
  } catch (e) {
    termPush('err', `启动失败: ${e.message}`);
    return { ok: false };
  }
  const id = ++TERM.execSeq;
  TERM.child = { id, proc: child };
  // 按流解码: 多字节字符被拆在两个 chunk 里也不会变成乱码
  const dec = new TextDecoder('utf-8');
  const utf8ok = (buf) => {
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; }
  };
  // Windows 的 cmd 内建命令(dir/copy/中文报错)按控制台 OEM 代码页(简体中文 GBK)输出,
  // 不是 UTF-8 —— 逐块判断, UTF-8 不合法就用 GBK 解一遍。
  const decodeMixed = (d) => {
    const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
    if (utf8ok(buf)) return dec.decode(buf, { stream: true });
    return new TextDecoder('gbk').decode(buf);
  };
  if (child.stdout) child.stdout.on('data', (d) => termPush('out', decodeMixed(d)));
  if (child.stderr) child.stderr.on('data', (d) => termPush('err', decodeMixed(d)));
  child.on('error', (e) => {
    termPush('err', `启动失败: ${e.message}`);
    TERM.child = null;
  });
  child.on('close', (code, sig) => {
    termPush('sys', sig ? `[被 ${sig} 结束]` : `[退出码 ${code}]`);
    if (TERM.child && TERM.child.id === id) TERM.child = null;
  });
  return { ok: true, pid: child.pid, id };
}

function termKill() {
  if (!TERM.child) return { ok: false, message: '没有正在跑的命令' };
  const pid = TERM.child.proc.pid;
  try {
    spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
  } catch {
    try { TERM.child.proc.kill(); } catch { /* ignore */ }
  }
  termPush('sys', '[手动停止]');
  TERM.child = null;
  return { ok: true };
}

/** 用系统默认浏览器打开一个 URL */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // `start` 会把第一个带引号的参数当成窗口标题, 所以显式塞一个空标题
      const p = spawn('cmd.exe', ['/c', 'start', '', url], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      p.on('error', () => {
        try { spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
      });
      p.unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch (e) {
    log('warn', `自动打开浏览器失败: ${e.message}`);
    return false;
  }
}

/**
 * 致命错误时给一张能看的页面。
 * GUI 子系统没有控制台, 静默退出会让主人完全不知道发生了什么,
 * 所以写一个错误页并用浏览器打开。
 */
function showFatalError(err) {
  const msg = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? err.stack : '';
  log('error', `启动失败: ${msg}`);
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>🐋 控制台启动失败</title><style>
body{margin:0;padding:48px;background:#071722;color:#dff3ff;
  font:15px/1.7 "Microsoft YaHei",system-ui,sans-serif}
.box{max-width:860px;margin:0 auto;background:#0e2b3d;border:1px solid #1d4a63;
  border-radius:14px;padding:28px 32px}
h1{margin:0 0 6px;font-size:20px;color:#ff6b6b}
.k{color:#7ba7bf;font-size:13px}
pre{background:#04121b;border:1px solid #1d4a63;border-radius:10px;padding:14px;
  overflow:auto;font:12px/1.6 Consolas,monospace;color:#ffb3b3;white-space:pre-wrap}
code{color:#3fd3c6}
</style></head><body><div class="box">
<h1>✖ 控制台启动失败</h1>
<p class="k">bili-studio v${VERSION} · ${new Date().toLocaleString('zh-CN')}</p>
<pre>${esc(msg)}</pre>
${stack ? `<p class="k">完整调用栈：</p><pre>${esc(stack)}</pre>` : ''}
<p class="k">完整日志：<code>${esc(LOG_FILE)}</code></p>
<p class="k">常见原因：端口被别的程序占用（换 <code>--port=8899</code> 试试）、
数据目录没有写权限（别放在 Program Files 下）。</p>
</div></body></html>`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ERR_PAGE, html, 'utf8');
    if (AUTO_OPEN) openBrowser(pathToFileURL(ERR_PAGE).href);
  } catch { /* ignore */ }
}

/** listen 失败时的分流处理 */
function onServerError(e) {
  const url = `http://${HOST}:${PORT}`;
  if (e.code === 'EADDRINUSE') {
    // 不是错误: 大概率主人又双击了一次, 直接把已有页面打开就行
    log('warn', `端口 ${PORT} 已被占用 —— 控制台多半已经在运行了`);
    log('info', `直接打开已有控制台: ${url}`);
    if (AUTO_OPEN) openBrowser(url);
    setTimeout(() => process.exit(0), 400);
    return;
  }
  if (e.code === 'EACCES') {
    log('error', `端口 ${PORT} 没有权限绑定, 换一个端口试试 (--port=8899)`);
  }
  showFatalError(e);
  setTimeout(() => process.exit(1), 400);
}

/* ------------------------------------------------------------------ */
/* 通用 HTTP 工具                                                      */
/* ------------------------------------------------------------------ */





/* ------------------------------------------------------------------ */
/* B 站业务                                                            */
/* ------------------------------------------------------------------ */



/* ------------------------------------------------------------------ */
/* 账户健康状态(v1.6.0)                                                */
/* ------------------------------------------------------------------ */

/**
 * 上次验活的结果缓存, 挂在账户对象上但不写进某个"正本"里 ——
 * 存到 config 才能跨重启保留, 所以 applyNavHealth() 会顺手 saveConfig()。
 */
function markHealth(acc, nav) {
  acc.health = {
    ok: !!nav.ok,
    code: nav.code,
    message: nav.message || '',
    checkedAt: Date.now(),
  };
  return acc.health;
}

/**
 * 验一次活并落盘。发任务前的守门员、账户卡片上的状态点都靠它。
 * 网络异常不当成"cookie 失效"——那是两码事, 别误报吓人。
 */
async function checkAccountHealth(acc) {
  if (!acc) return { ok: false, code: null, message: '账户不存在' };
  if (!acc.sessdata || !acc.biliJct) {
    return markHealth(acc, { ok: false, code: null, message: 'cookie 不完整(缺 SESSDATA 或 bili_jct)' });
  }
  try {
    const nav = await biliNav(acc);
    if (nav.ok) {
      acc.uname = nav.uname || acc.uname;
      acc.mid = nav.mid || acc.mid;
      acc.level = nav.level ?? acc.level;
    }
    return { ...nav, health: markHealth(acc, nav) };
  } catch (e) {
    // 网络问题: 不标记为失效, 只记录"没检查成功"
    return {
      ok: false, code: null, message: e.message, networkError: true,
      health: { ...(acc.health || {}), checkedAt: Date.now() },
    };
  }
}

/** 给发任务用的守门员: 失效就抛错, 避免跑到一半才发现 */
async function assertAccountUsable(acc) {
  // 刚过期不久(60 秒内)就不用再验一遍, 省一次请求
  const h = acc.health;
  if (h && h.checkedAt && Date.now() - h.checkedAt < 60_000 && !h.ok && !h.networkError) {
    throw new Error(`账户「${acc.uname || acc.name || acc.id}」的 cookie 已失效`
      + `（${h.code ?? '-'} ${h.message || ''}），请重新粘贴 cookie 再跑`);
  }
  const r = await checkAccountHealth(acc);
  if (r.networkError) {
    log('warn', `账户验活时网络异常: ${r.message} —— 不当作 cookie 失效, 继续跑`);
    return;
  }
  await saveConfig();
  if (!r.ok) {
    throw new Error(`账户「${acc.uname || acc.name || acc.id}」的 cookie 已失效`
      + `（${r.code ?? '-'} ${r.message || ''}），请重新粘贴 cookie 再跑`);
  }
}








/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 评论组装                                                            */
/* ------------------------------------------------------------------ */

function buildMessage(body, mentions, signature) {
  const at = (mentions || []).filter((m) => m && m.uname).map((m) => `@${m.uname}`).join(' ');
  const sig = (signature || '').trim();
  return [at, body, sig ? `——${sig}` : ''].filter(Boolean).join(' ');
}

function pickMentions(ids) {
  const set = new Set(ids || []);
  if (set.size) return config.mentions.filter((m) => set.has(m.id));
  return config.mentions.filter((m) => m.enabled);
}

/* ------------------------------------------------------------------ */
/* 任务执行                                                            */
/* ------------------------------------------------------------------ */

let taskSeq = 0;

// v1.5.3(P2-9): 任务历史原来是内存数组, 一重启就没了。现在落盘到 data/history.jsonl,
// 启动时读回来。这里不再保留独立的 TASK_HISTORY, 统一走 history.mjs。
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

/**
 * 私信模式的任务体: 给 @ 名单里的人挨个发私信, 完全不动评论区。
 * 内容只由「问候语风格 + 署名」支配 —— 私信是对人的, 所以不拼 @。
 * 条数 = 发几个人(按 @ 名单顺序)。
 */
async function runDmBody({ acc, targets, times, useDry, result }) {
  const wantCard = dmFormNow() === 'card';

  // 「本人」要先剔出去: 它不该占用「每次发几条」的名额。
  // 以前是先 slice 再在循环里跳过自己, 结果名单里凡是有自己(登录账号本身也在 @ 名单里),
  // 这一轮就白发一条 —— 主人说的「检测到本人跳过的同时私信下一个」就是这个。
  const isSelf = (m) => String(m.mid || '') === String(acc.mid || '');
  const selfList = targets.filter(isSelf);
  const pool = targets.filter((m) => !isSelf(m));
  // 人数上限: 「每次跑几条」在私信模式下含义是「最多发给几个人」。
  // 但它默认是 1(视频条数的默认值), 如果照搬就会变成「只发第一个人 —— 主人说的
  // 「发完第一个人就停了, 第二个人没发」就是这个。所以 1 当成「不限, 全名单都发」,
  // 显式填 2 以上才真的当上限。
  const cap = Number(times) > 1 ? Number(times) : pool.length;
  const who = pool.slice(0, cap);
  result.planned = who.length;

  for (const m of selfList) {
    result.skipped++;
    result.items.push({
      bvid: '', title: '', uname: m.uname, body: '', message: '',
      status: 'skipped', code: null, rpid: null, form: '',
    });
    log('warn', `@${m.uname} 就是当前账户自己(${acc.mid}), 不能给自己发私信 —— 跳过, 不占名额`);
  }
  if (!who.length) {
    log('warn', pool.length
      ? '这一轮没有可发的人'
      : '@ 名单里除了自己没别人了, 去「@ 名单」再加人');
  }

  const withTitle = config.task.dmTitle !== false;
  log('step', `私信模式: 可发 ${pool.length} 人, 本轮发 ${who.length} 人 → ${who.map((m) => m.uname).join('、') || '(无)'}`
    + `  形态=${wantCard ? '原生卡片(被拒自动降级文字)' : '文本 + 链接'}`
    + `  视频标题=${withTitle ? '带' : '不带'}`);

  const carrier = await pickCarrierVideo(acc);
  if (carrier) {
    log('info', `载体视频: ${carrier.bvid} 《${carrier.title}》 UP=${carrier.author}`);
  } else {
    log('warn', wantCard
      ? '没找到能放进卡片的视频, 这一轮全部走纯文字'
      : '没找到视频, 这一轮私信不带链接');
  }

  for (let i = 0; i < who.length; i++) {
    if (runAbort) { log('warn', '任务被手动停止'); break; }
    const t = who[i];
    const item = {
      bvid: carrier?.bvid || '', title: carrier?.title || '', uname: t.uname,
      body: '', message: '', status: '', code: null, rpid: null, form: '',
    };

    if (!/^\d+$/.test(String(t.mid || ''))) {
      item.status = 'failed';
      result.failed++;
      log('error', `@${t.uname} 没有 mid, 先去「@ 名单」点一次「查 mid」`);
      result.items.push(item);
      continue;
    }
    log('step', `[${i + 1}/${who.length}] → @${t.uname} (mid=${t.mid})`);

    let body;
    try {
      body = await dsWriteDmGreeting(t, carrier);
      log('info', `DS 生成私信: ${body}`);
    } catch (e) {
      body = localDmGreeting(t, carrier, i);
      log('warn', `DS 写私信失败, 用本地模板兜底: ${e.message}`);
    }

    // 字数管理: 只卡正文, 署名和 @ 昵称不算进去(v1.5.1)
    const limit = dmCharLimit();
    const before = countChars(body);
    if (before > limit) {
      const c = clipChars(body, limit);
      body = c.text;
      log('warn', `正文 ${before} 字超过上限 ${limit}, 已截到 ${countChars(body)} 字: ${body}`);
    } else {
      log('info', `正文字数 ${before}/${limit}`);
    }

    // 视频标题: 开关打开时, 文字私信里多一行《标题》; 卡片形态下它的作用是
    // 让卡片标题用视频真名(关掉就沿用问候语当卡片标题)。
    const titleLine = withTitle && carrier?.title ? `《${carrier.title}》` : '';
    const message = buildMessage(body, [], config.signature)
      + (titleLine ? `\n${titleLine}` : '')
      + (!wantCard && carrier ? `\n${videoUrlOf(carrier)}` : '');
    item.body = body;
    item.message = message;
    log('info', `完整私信: ${message.replace(/\n/g, ' ⏎ ')}`);

    if (useDry) {
      item.status = 'dry-run';
      result.skipped++;
      log('warn', '干跑模式: 不发送 (关掉"干跑"才会真发)');
      result.items.push(item);
      continue;
    }

    if (config.stats.postedToday >= (config.task.dailyLimit || 10)) {
      item.status = 'daily-limit';
      result.skipped++;
      log('warn', `已达每日上限 ${config.task.dailyLimit} 条, 剩下的不发了`);
      result.items.push(item);
      break;
    }

    try {
      const r = await sendDm({
        acc, target: t, text: message, video: carrier, preferCard: wantCard,
        cardTitle: withTitle ? null : body,
      });
      item.code = r.code;
      item.form = r.form;
      item.msgKey = r.msgKey ?? null;
      if (r.ok) {
        item.status = 'posted';
        result.posted++;
        config.stats.postedToday++;
        await saveConfig();
        log('ok', `私信已发出 → @${t.uname} (${r.form === 'card' ? '原生卡片' : '纯文字'}`
          + `${r.fellBack ? ', 卡片被拒后降级' : ''}) msg_key=${r.msgKey}`);
      } else if (r.code === 21026) {
        // 服务端说「不能给自己发」——说明本地 acc.mid 没取到, 漏判了。不算失败, 继续下一个。
        item.status = 'skipped';
        result.skipped++;
        log('warn', `@${t.uname} 是当前账户本人(服务端 21026), 跳过, 继续下一个`);
      } else {
        item.status = 'failed';
        result.failed++;
        log('error', `私信失败 code=${r.code} ${DM_ERRORS[r.code] || r.message || ''}`);
        if (r.code === -101 || r.code === -111) {
          log('error', '账户凭据有问题, 本轮中止');
          result.items.push(item);
          break;
        }
      }
    } catch (e) {
      item.status = 'failed';
      result.failed++;
      log('error', `私信异常: ${e.message}`);
    }
    result.items.push(item);

    if (i < who.length - 1) {
      const wait = Math.max(3, config.task.delaySeconds || 12);
      log('info', `等 ${wait} 秒再发下一个(防刷屏)`);
      for (let s = 0; s < wait * 2 && !runAbort; s++) await sleep(500);
    }
  }
}

async function runTask({ trigger = 'manual', repeat, dryRun, dm, mentions, accountId } = {}) {
  if (running) throw new Error('已有任务在跑, 先等它跑完或者点停止');
  running = true;
  runAbort = false;
  const taskId = `t${Date.now()}`;
  const startedAt = Date.now();
  const result = { taskId, trigger, startedAt, planned: 0, posted: 0, failed: 0, skipped: 0, items: [] };

  try {
    rollStats();
    const acc = config.accounts.find((a) => a.id === (accountId || config.activeAccountId))
      || config.accounts[0];
    if (!acc) throw new Error('还没添加账户, 先去"账户"页加一个');

    const useDry = dryRun === undefined ? config.task.dryRun : !!dryRun;
    const useDm = dm === undefined ? !!config.task.dm : !!dm;
    const times = Math.max(1, Math.min(20, Number(repeat ?? config.task.videosPerRun) || 1));
    const targets = pickMentions(mentions);
    if (!targets.length) throw new Error('@ 名单是空的, 先去"@ 名单"页加人');

    // v1.6.0: 开跑前先验活。以前是跑到第 3 条才炸, 现在一条都别发,
    // 直接告诉你哪个号的 cookie 该换了。
    await assertAccountUsable(acc);

    log('step', `任务开始 [${trigger}] 账户=${acc.uname || acc.id} 条数=${times} `
      + `干跑=${useDry ? '是' : '否'} 私信=${useDm ? '是' : '否'}`);
    log('info', `要 @ 的人: ${targets.map((m) => m.uname).join('、')}`);

    // 私信模式: 完全不碰评论区, 走另一条更短的路径
    if (useDm) {
      await runDmBody({ acc, targets, times, useDry, result });
      result.ms = Date.now() - startedAt;
      log(result.failed ? 'warn' : 'ok',
        `任务结束(私信): 计划${result.planned} 成功${result.posted} 失败${result.failed} `
        + `跳过${result.skipped} 用时${(result.ms / 1000).toFixed(1)}s`);
      return result;
    }

    // 1) 找视频
    let videos = [];
    if (config.task.videoSource === 'manual') {
      const bvids = String(config.task.manualBvids || '').split(/[\s,，]+/).map(parseBvid).filter(Boolean);
      if (!bvids.length) throw new Error('手动模式但没填 BV 号');
      log('step', `手动模式, 解析到 ${bvids.length} 个 BV 号`);
      for (const bv of bvids.slice(0, times)) {
        try {
          videos.push(await biliVideoInfo(bv, acc));
        } catch (e) {
          log('warn', `跳过 ${bv}: ${e.message}`);
        }
      }
    } else {
      let keywords = Array.isArray(config.keywords) && config.keywords.length
        ? config.keywords
        : ['无厘头 搞笑'];
      if (config.keywords?.length) {
        log('info', `用缓存的关键词(${config.keywords.length}个): ${keywords.join(' / ')}`);
      } else {
        log('warn', '还没分析过偏好, 用默认关键词。建议先去"内容偏好"页点一下「用 DS 分析」');
      }

      const pages = Math.max(1, Math.min(5, config.task.searchPages || 1));
      const seen = new Set();
      for (const kw of keywords) {
        if (videos.length >= times * 3 || runAbort) break;
        for (let p = 1; p <= pages; p++) {
          if (runAbort) break;
          try {
            const list = await biliVideoSearch(kw, p, acc);
            for (const v of list) {
              if (seen.has(v.bvid)) continue;
              seen.add(v.bvid);
              videos.push({ ...v, reply: undefined, like: undefined });
            }
            log('info', `搜索「${kw}」第${p}页 -> 累计 ${videos.length} 条候选`);
          } catch (e) {
            log('warn', `搜索「${kw}」第${p}页失败: ${e.message}`);
          }
          await sleep(1200);
        }
      }
      // 按播放量排序取前 N, 太冷门的不要
      videos = videos.filter((v) => (v.play || 0) >= 10000).sort((a, b) => b.play - a.play);
      videos = videos.slice(0, times);
    }

    result.planned = videos.length;
    if (!videos.length) throw new Error('没找到合适的视频');

    // 2) 逐条发言
    for (let i = 0; i < videos.length; i++) {
      if (runAbort) { log('warn', '任务被手动停止'); break; }
      const v = videos[i];
      const item = { bvid: v.bvid, title: v.title, body: '', message: '', status: '', code: null, rpid: null };

      log('step', `[${i + 1}/${videos.length}] ${v.bvid} 《${v.title}》 UP=${v.author} 播放=${v.play}`);

      // 生成评论
      let body;
      try {
        body = await dsWriteGreeting(v, targets);
        log('info', `DS 生成正文: ${body}`);
      } catch (e) {
        body = localGreeting(v, i);
        log('warn', `DS 写评论失败, 用本地模板兜底: ${e.message}`);
      }
      const message = buildMessage(body, targets, config.signature);
      item.body = body;
      item.message = message;
      log('info', `完整评论: ${message}`);

      if (useDry) {
        item.status = 'dry-run';
        result.skipped++;
        log('warn', `干跑模式: 不发送 (关掉"干跑"开关才会真发)`);
        result.items.push(item);
        continue;
      }

      // 每日上限
      if (config.stats.postedToday >= (config.task.dailyLimit || 10)) {
        item.status = 'daily-limit';
        result.skipped++;
        log('warn', `已达每日上限 ${config.task.dailyLimit} 条, 剩下的不发了`);
        result.items.push(item);
        break;
      }

      try {
        const r = await biliPostComment({ acc, aid: v.aid, message });
        item.code = r.code;
        if (r.code === 0) {
          item.status = 'posted';
          item.rpid = (r.data || {}).rpid_str || (r.data || {}).rpid || null;
          result.posted++;
          config.stats.postedToday++;
          await saveConfig();
          log('ok', `发送成功 rpid=${item.rpid}`, { url: `https://www.bilibili.com/video/${v.bvid}` });
        } else {
          item.status = 'failed';
          result.failed++;
          const hint = REPLY_ERRORS[r.code] || r.message;
          log('error', `发送失败 code=${r.code} ${hint}`);
          if (r.code === -107 || r.code === -101 || r.code === -111) {
            log('error', '账户凭据有问题, 本轮中止');
            result.items.push(item);
            break;
          }
        }
      } catch (e) {
        item.status = 'failed';
        result.failed++;
        log('error', `发送异常: ${e.message}`);
      }
      result.items.push(item);

      if (i < videos.length - 1 && !useDry) {
        const wait = Math.max(3, config.task.delaySeconds || 12);
        log('info', `等 ${wait} 秒再发下一条(防刷屏)`);
        for (let s = 0; s < wait * 2 && !runAbort; s++) await sleep(500);
      }
    }

    result.ms = Date.now() - startedAt;
    log(result.failed ? 'warn' : 'ok',
      `任务结束: 计划${result.planned} 成功${result.posted} 失败${result.failed} 跳过${result.skipped} 用时${(result.ms / 1000).toFixed(1)}s`);
  } catch (e) {
    result.error = e.message;
    log('error', `任务中止: ${e.message}`);
  } finally {
    running = false;
    appendHistory(result);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 定时任务                                                            */
/* ------------------------------------------------------------------ */

// 到点后最多容忍延迟多久还补跑。超过就认为"错过了", 直接跳下一班。
// 5 分钟: 够容忍浏览器刷新/短暂卡顿, 又不至于在半夜睡醒后突然开跑。
const CATCHUP_GRACE = 5 * 60 * 1000;

function computeNextRun(sch, from = Date.now()) {
  if (sch.mode === 'interval') {
    const every = Math.max(1, Number(sch.everyMinutes) || 30) * 60000;
    return from + every;
  }
  // clock 模式
  const [hh, mm] = String(sch.clockAt || '09:00').split(':').map((n) => Number(n) || 0);
  const base = sch.clockDate ? new Date(`${sch.clockDate}T00:00:00`) : new Date(from);
  const next = new Date(base);
  next.setHours(hh, mm, 0, 0);
  if (next.getTime() <= from) {
    // 一次性(指定了日期、不每天重复): 时间已过就直接返回 null, 表示"已过期, 不再执行"
    if (sch.clockDate && !sch.repeatDaily) return null;
    // 否则推进到下一个符合条件的时刻
    next.setDate(next.getDate() + 1);
    while (next.getTime() <= from) next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function startScheduler() {
  setInterval(async () => {
    if (running) return;
    const now = Date.now();
    for (const sch of config.schedules) {
      if (!sch.enabled) continue;
      if (!sch.nextRun) {
        sch.nextRun = computeNextRun(sch, now);
        // 一次性闹钟时间已过: computeNextRun 返回 null, 这里要顺手停用,
        // 否则每个 tick 都重算一遍 null, 任务永远挂着"启用"却永不执行。
        if (sch.nextRun === null) {
          sch.enabled = false;
          log('warn', `定时任务「${sch.name}」的设定时间已过, 已自动停用`);
        }
        await saveConfig();
        continue;
      }
      if (now >= sch.nextRun) {
        // v1.5.3(P2-8): 补跑判定。
        // 以前只要进程活着, 到点就跑; 但主人合盖/休眠一小时回来后,
        // 定时器被冻结, 醒来时 now 已经远远超过 nextRun, 任务要么被跳过,
        // 要么在一个不合适的时刻突然开跑。现在: 超过 CATCHUP_GRACE 就不补了,
        // 直接跳到下一个周期, 并在日志里明说 —— 宁可漏一次, 不要在半夜炸。
        const lateBy = now - sch.nextRun;
        if (lateBy > CATCHUP_GRACE) {
          sch.nextRun = computeNextRun(sch, now);
          if (sch.mode === 'clock' && sch.clockDate && !sch.repeatDaily) {
            sch.enabled = false;
            log('warn', `定时任务「${sch.name}」的设定时刻错过 ${Math.round(lateBy / 60000)} 分钟, 已自动停用`);
          } else {
            const at = new Date(sch.nextRun).toLocaleString('zh-CN', { hour12: false });
            log('warn', `定时任务「${sch.name}」错过 ${Math.round(lateBy / 60000)} 分钟(可能刚休眠过), 不补跑, 下次 ${at}`);
          }
          await saveConfig();
          break;
        }
        log('step', `⏰ 定时任务「${sch.name}」触发`);
        sch.lastRun = now;
        sch.nextRun = computeNextRun(sch, now);
        if (sch.mode === 'clock' && sch.clockDate && !sch.repeatDaily) sch.enabled = false;
        await saveConfig();
        runTask({
          trigger: `定时:${sch.name}`,
          repeat: sch.videosPerRun,
          mentions: sch.mentions,
          accountId: sch.accountId,
          dryRun: sch.dryRun,
          dm: sch.dm,
        }).catch((e) => log('error', `定时任务出错: ${e.message}`));
        break;
      }
    }
  }, 20000);
}

/* ------------------------------------------------------------------ */
/* 单实例守卫 + 页面关闭后照样跑(v1.5.3, P2-8)                          */
/* ------------------------------------------------------------------ */

/**
 * 判断是不是"页面只是打开了新的标签页/刷新", 而不是"主人真的把控制台关掉了"。
 * 这个接口最多会让定时任务**延后 90 秒**, 不算破坏性操作; 但它确实会让任务在页面关掉后继续跑,
 * 所以界面上必须明确告诉主人, 不能偷偷来。
 */
async function askCloseIntent() {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      question: '浏览器页面已经断开, 但控制台服务还在后台跑。',
      detail: '定时任务现在是否继续保持运行?(90 秒内没有回应就默认继续跑, 这样关掉页面/刷新不会中断定时)',
    });
    const req = http.request({
      host: HOST,
      port: PORT,
      path: '/api/shutdown',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 90_000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(false); });
    req.on('error', () => resolve(false));
    req.end(payload);
  });
}

function installSingleInstanceGuard(server) {
  // 这里用 http.Server 的 'connection' 计数: 没有活动连接时说明页面已经关了。
  // 加一个宽限期, 避免刷新页面瞬间误判。
  let everServed = false;
  const sockets = new Set();
  server.on('connection', (sock) => {
    everServed = true;
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  process.on('SIGINT', () => {
    log('info', '收到 Ctrl+C, 正在关闭控制台');
    saveConfig().catch(() => {}).finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    log('info', '收到终止信号, 正在关闭控制台');
    process.exit(0);
  });

  return {
    stats: () => ({ everServed, live: sockets.size }),
    askCloseIntent,
  };
}

/** 为错过的任务算一个"下次该跑"的时间, 用于启动日志里提示 */
function describeSchedules() {
  if (!config.schedules.length) return '没有任何定时任务';
  const enabled = config.schedules.filter((s) => s.enabled);
  if (!enabled.length) return `${config.schedules.length} 个定时任务, 但都处于停用状态`;
  return enabled.map((s) => {
    const at = s.nextRun ? new Date(s.nextRun).toLocaleString('zh-CN', { hour12: false }) : '未排期';
    return `「${s.name}」下次 ${at}`;
  }).join(' / ');
}

/* ------------------------------------------------------------------ */
/* HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return {}; }
}

function publicConfig() {
  const mask = (v) => (v ? `${v.slice(0, 7)}***${v.slice(-4)}` : '');
  return {
    ...config,
    version: VERSION,
    ds: {
      ...config.ds,
      apiKey: '',
      apiKeyMask: mask(dsKeyMem),
      apiKeySource: dsKeySource,
    },
    accounts: config.accounts.map((a) => ({
      ...a,
      sessdata: a.sessdata ? `${a.sessdata.slice(0, 6)}***(${a.sessdata.length}位)` : '',
      biliJct: a.biliJct ? '******' : '',
      hasCookie: !!(a.sessdata && a.biliJct),
    })),
    running,
    logSeq,
    // 配置版本信息: 前端状态栏能直接看出「这份配置是哪一版、这次启动有没有迁移过」
    configVersion: {
      current: SCHEMA_VERSION,
      stored: Number(config.schemaVersion) || 0,
      migrated: lastMigration,
    },
  };
}

const ROUTES = {
  'GET /api/state': async () => publicConfig(),

  'GET /api/changelog': async () => ({
    version: VERSION,
    text: await readChangelog(),
  }),

  'POST /api/accounts': async (body) => {
    const cookieText = String(body.cookieText || '');
    const parsed = parseCredentialText(cookieText);
    const acc = {
      id: `acc${Date.now()}`,
      name: body.name || '新账户',
      sessdata: body.sessdata || parsed.SESSDATA || '',
      biliJct: body.biliJct || parsed.bili_jct || '',
      buvid3: body.buvid3 || parsed.buvid3 || '',
      buvid4: parsed.buvid4 || '',
      dedeUserId: body.dedeUserId || parsed.DedeUserID || '',
      uname: '', mid: '', level: null, addedAt: Date.now(),
    };
    if (!acc.sessdata) {
      throw new Error('没识别出 SESSDATA。请确认粘的是 Cookie 或请求头原文（含 SESSDATA=...）');
    }
    config.accounts.push(acc);
    const nav = await biliNav(acc);
    acc.uname = nav.uname; acc.mid = nav.mid; acc.level = nav.level;
    if (nav.ok) log('ok', `账户「${nav.uname}」已添加 (Lv${nav.level}, mid=${nav.mid})`);
    else log('warn', `账户已保存但登录态异常: ${nav.code} ${nav.message}`);
    if (!config.activeAccountId) config.activeAccountId = acc.id;
    await saveConfig();
    return {
      ...publicConfig(),
      parsedFields: parsed.found,
    };
  },

  'POST /api/accounts/activate': async (body) => {
    config.activeAccountId = body.id;
    await saveConfig();
    log('info', `切换使用账户: ${config.accounts.find((a) => a.id === body.id)?.uname || body.id}`);
    return publicConfig();
  },

  'POST /api/accounts/test': async (body) => {
    const acc = config.accounts.find((a) => a.id === body.id);
    if (!acc) throw new Error('账户不存在');
    const nav = await biliNav(acc);
    acc.uname = nav.uname || acc.uname;
    acc.mid = nav.mid || acc.mid;
    acc.level = nav.level ?? acc.level;
    markHealth(acc, nav);
    await saveConfig();
    log(nav.ok ? 'ok' : 'error',
      `测试「${acc.name}」: ${nav.ok ? `登录正常, ${nav.uname} Lv${nav.level}` : `异常 ${nav.code} ${nav.message}`}`);
    return { nav, config: publicConfig() };
  },

  // 一次性验活所有账户, 前端刷新时调一次
  'POST /api/accounts/health': async () => {
    const out = [];
    for (const acc of config.accounts) {
      const r = await checkAccountHealth(acc);
      out.push({ id: acc.id, ok: r.ok, code: r.code, message: r.message, networkError: !!r.networkError });
      if (!r.ok && !r.networkError) log('warn', `账户「${acc.uname || acc.name || acc.id}」cookie 已失效`);
    }
    await saveConfig();
    return { accounts: out, config: publicConfig() };
  },

  'POST /api/accounts/delete': async (body) => {
    config.accounts = config.accounts.filter((a) => a.id !== body.id);
    if (config.activeAccountId === body.id) config.activeAccountId = config.accounts[0]?.id || '';
    await saveConfig();
    log('info', '账户已删除');
    return publicConfig();
  },

  'POST /api/mentions': async (body) => {
    const m = { id: `m${Date.now()}`, mid: '', uname: '', enabled: true, note: body.note || '' };
    if (body.mid) { m.mid = String(body.mid).trim(); m.uname = String(body.uname || '').trim(); }
    if (!m.uname || !m.mid) {
      const kw = String(body.uname || '').trim();
      if (!kw) throw new Error('要填昵称或者 mid');
      const acc = config.accounts.find((a) => a.id === config.activeAccountId);
      const list = await biliUserSearch(kw, acc);
      const exact = list.find((u) => u.uname === kw) || list[0];
      if (!exact) throw new Error(`搜不到用户「${kw}」`);
      m.uname = exact.uname; m.mid = exact.mid; m.fans = exact.fans;
      log('ok', `查到用户: ${m.uname} (mid=${m.mid}${m.fans !== undefined ? ', 粉丝' + m.fans : ''})`);
    }
    if (config.mentions.some((x) => x.mid === m.mid)) throw new Error('这个人已经在名单里了');
    config.mentions.push(m);
    await saveConfig();
    return publicConfig();
  },

  'POST /api/mentions/toggle': async (body) => {
    const m = config.mentions.find((x) => x.id === body.id);
    if (m) m.enabled = !!body.enabled;
    await saveConfig();
    return publicConfig();
  },

  'POST /api/mentions/delete': async (body) => {
    config.mentions = config.mentions.filter((x) => x.id !== body.id);
    await saveConfig();
    return publicConfig();
  },

  'POST /api/mentions/resolve': async (body) => {
    const kw = String(body.keyword || '').trim();
    if (!kw) throw new Error('填个昵称');
    const acc = config.accounts.find((a) => a.id === config.activeAccountId);
    const list = await biliUserSearch(kw, acc);
    log('info', `用户搜索「${kw}」-> ${list.length} 个结果`);
    return { results: list };
  },

  'POST /api/settings': async (body) => {
    for (const key of ['contentPreference', 'stylePreference', 'signature']) {
      if (typeof body[key] === 'string') config[key] = body[key];
    }
    if (Array.isArray(body.keywords)) {
      config.keywords = body.keywords.map((k) => String(k).trim()).filter(Boolean);
    }
    if (body.ds) {
      const prevBase = config.ds.baseUrl;
      const prevRef = config.ds.apiKeyRef;
      const prevModel = config.ds.model;

      // 1) 先更新字段 —— findDsKey 的兜底逻辑会参考 baseUrl,
      //    所以必须先把新地址写进去, 否则会拿旧地址去猜凭据名。
      for (const key of ['model', 'baseUrl', 'endpoint', 'extraHeaders', 'authMode']) {
        if (typeof body.ds[key] === 'string') config.ds[key] = body.ds[key].trim();
      }
      if (!['bearer', 'api-key', 'x-api-key', 'none'].includes(config.ds.authMode)) {
        config.ds.authMode = 'bearer';
      }
      if (typeof body.ds.apiKeyRef === 'string') {
        config.ds.apiKeyRef = body.ds.apiKeyRef.trim() || 'DEEPSEEK_API_KEY';
      }
      // 换了供应商/模型, 之前记下的"不支持 response_format"就不算数了
      if (config.ds.baseUrl !== prevBase || config.ds.model !== prevModel) {
        jsonModeUnsupported = false;
      }

      // 2) 界面上手动粘的 Key 优先，且只进内存、不写磁盘
      const k = String(body.ds.apiKey || '').trim();
      if (k && !k.includes('***')) {
        dsKeyMem = k;
        dsKeySource = '控制台手动填写(仅内存)';
        log('ok', 'AI Key 已更新(只存在内存里, 不会写进配置文件)');
      } else if (config.ds.apiKeyRef !== prevRef || config.ds.baseUrl !== prevBase || !dsKeyMem) {
        // 3) 换了供应商或凭据名，就重新去凭据文件里读一次，主人不用反复粘 Key
        const found = findDsKey();
        dsKeyMem = found.key;
        dsKeySource = found.source;
        log(found.key ? 'ok' : 'warn',
          `按凭据名 ${config.ds.apiKeyRef} 读取 Key：${found.key ? '成功' : '没找到'}（${found.source}）`);
      }
    }
    if (body.task) config.task = { ...config.task, ...body.task };
    await saveConfig();
    log('info', '设置已保存');
    return publicConfig();
  },

  'POST /api/ds/test': async () => {
    const info = resolveAiRequest();
    // 回显请求头时把凭据打码, 免得把 key 又送回浏览器
    const safeHeaders = { ...info.headers };
    for (const h of ['Authorization', 'api-key', 'x-api-key']) {
      if (safeHeaders[h]) safeHeaders[h] = '***（已隐藏）';
    }
    const where = `${info.url} | model=${config.ds.model} | 鉴权=${info.authMode}`;
    try {
      const out = await dsChat([{ role: 'user', content: '只回复两个字: 在线' }], { temperature: 0 });
      log('ok', `AI 接口连通 → ${where}，回复: ${out.trim().slice(0, 40)}`);
      return {
        ok: true, reply: out.trim(), endpoint: info.url,
        model: config.ds.model, authMode: info.authMode, headers: safeHeaders,
      };
    } catch (e) {
      // 测试失败不算接口出错, 返回 200 让前端好好显示详情
      log('error', `AI 接口测试失败 → ${where}：${e.message}`);
      return {
        ok: false, error: e.message, endpoint: info.url,
        model: config.ds.model, authMode: info.authMode, headers: safeHeaders,
      };
    }
  },

  'POST /api/ds/analyze': async () => {
    if (!config.accounts.length) log('warn', '提示: 还没添加账户, 搜索可能受限');
    const acc = config.accounts.find((a) => a.id === config.activeAccountId);
    const a = await dsAnalyzePreference();
    const keywords = a.keywords;
    config.keywords = keywords;
    config.analysis = a;
    await saveConfig();
    log('ok', `DS 关键词已缓存: ${keywords.join(' / ')}`);
    log('info', `风格要点: ${a.styleNotes || '(无)'}`);
    const preview = [];
    for (const kw of keywords.slice(0, 2)) {
      try {
        const list = await biliVideoSearch(kw, 1, acc);
        preview.push({ keyword: kw, count: list.length, top: list.slice(0, 5) });
      } catch (e) {
        preview.push({ keyword: kw, error: e.message });
      }
      await sleep(900);
    }
    return { analysis: a, preview };
  },

  'POST /api/task/run': async (body) => {
    if (running) throw new Error('已有任务在跑');
    runTask({
      trigger: '手动',
      repeat: body.repeat,
      dryRun: body.dryRun,
      dm: body.dm,
      mentions: body.mentions,
      accountId: body.accountId,
    }).catch((e) => log('error', `任务异常: ${e.message}`));
    return { started: true, running: true };
  },

  'POST /api/task/stop': async () => {
    runAbort = true;
    log('warn', '收到停止指令, 当前这条发完就停');
    return { ok: true };
  },

  'GET /api/task/history': async () => ({
    history: recentHistory(30),
    running,
    file: historyFilePath(),
  }),

  // v1.5.3: 清空历史(只清记录, 不动配置)
  'POST /api/task/history/clear': async () => {
    clearHistory();
    log('info', '任务历史已清空');
    return { ok: true };
  },

  'POST /api/preview': async (body) => {
    const dmOn = body.dm === undefined ? !!config.task.dm : !!body.dm;
    const form = dmFormNow();
    const withTitle = body.dmTitle === undefined ? config.task.dmTitle !== false : !!body.dmTitle;
    const targets = pickMentions(body.mentions);
    const body20 = body.text || '（这里放 DS 生成的正文）';
    const limit = dmCharLimit();
    const preview = dmOn ? clipChars(body20, limit).text : body20;
    let message = buildMessage(preview, dmOn ? [] : targets, config.signature);
    if (dmOn && withTitle) message += '\n《这条视频的标题》';
    if (dmOn && form === 'texturl') message += '\nhttps://www.bilibili.com/video/BV…（这条视频的链接）';
    return {
      dm: dmOn, form, title: withTitle, message,
      chars: dmOn ? countChars(preview) : countChars(body20),
      charsLimit: dmOn ? limit : null,
    };
  },

  'POST /api/schedules': async (body) => {
    const sch = {
      id: `s${Date.now()}`,
      name: body.name || '未命名任务',
      enabled: body.enabled !== false,
      mode: body.mode === 'clock' ? 'clock' : 'interval',
      everyMinutes: Number(body.everyMinutes) || 60,
      clockDate: body.clockDate || '',
      clockAt: body.clockAt || '09:00',
      repeatDaily: body.repeatDaily !== false,
      videosPerRun: Number(body.videosPerRun) || 1,
      dryRun: body.dryRun !== false,
      dm: body.dm === true,
      accountId: body.accountId || config.activeAccountId,
      mentions: Array.isArray(body.mentions) ? body.mentions : [],
      nextRun: null,
      lastRun: null,
      createdAt: Date.now(),
    };
    sch.nextRun = computeNextRun(sch);
    config.schedules.push(sch);
    await saveConfig();
    log('ok', `定时任务「${sch.name}」已创建, 下次执行: ${new Date(sch.nextRun).toLocaleString('zh-CN')}`);
    return publicConfig();
  },

  'POST /api/schedules/toggle': async (body) => {
    const s = config.schedules.find((x) => x.id === body.id);
    if (s) {
      s.enabled = !!body.enabled;
      s.nextRun = s.enabled ? computeNextRun(s) : s.nextRun;
    }
    await saveConfig();
    return publicConfig();
  },

  'POST /api/schedules/delete': async (body) => {
    config.schedules = config.schedules.filter((x) => x.id !== body.id);
    await saveConfig();
    log('info', '定时任务已删除');
    return publicConfig();
  },

  'POST /api/logs/clear': async () => {
    LOGS.length = 0;
    return { ok: true };
  },

  /* ---------- 站内终端 ---------- */

  'POST /api/term/exec': async (body) => termExec(body.cmd),

  'POST /api/term/kill': async () => termKill(),

  'POST /api/term/clear': async () => {
    TERM.buf.length = 0;
    return { ok: true, seq: TERM.seq };
  },

  // 打包成 GUI 子系统后没有控制台窗口可关, 所以给网页一个正经的退出按钮,
  // 免得主人要去任务管理器里找进程。
  'POST /api/shutdown': async () => {
    log('warn', '收到关闭指令, 控制台将在 1 秒后退出');
    // 先让响应回到浏览器, 否则前端只会看到连接被重置
    setTimeout(() => process.exit(0), 1000);
    return { ok: true, message: '控制台已关闭' };
  },

  /* ---------- 皮肤 ---------- */

  'GET /api/skins': async () => {
    const presets = [
      { id: 'default', name: '深海默认', type: 'preset' },
      { id: 'ocean', name: '幽蓝深洋', type: 'preset' },
      { id: 'sakura', name: '樱吹雪', type: 'preset' },
      { id: 'dark', name: '纯黑省电', type: 'preset' },
    ];
    let custom = [];
    try {
      await fsp.mkdir(SKINS_DIR, { recursive: true });
      const files = await fsp.readdir(SKINS_DIR);
      custom = files
        .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
        .map((f) => ({ id: `custom:${f}`, name: f, type: 'custom', url: `/api/skin/file/${f}` }));
    } catch { /* 目录建不出来就返回空 */ }
    return { presets, custom, active: config.skin.active };
  },

  'POST /api/skin/activate': async (body) => {
    const id = String(body.id || 'default');
    config.skin.active = id;
    await saveConfig();
    log('info', `皮肤已切换: ${id}`);
    return { active: id };
  },

  // 主题配色存档。前端管「有哪些变量、每套什么色」, 后端只负责把选择存进 config.json,
  // 这样换端口 / 换浏览器还认得出用户调好的配色。
  // 校验: preset 是 0..999 的整数; custom 只收对象里值为字符串的键, 且整体不许超过 8KB,
  // 免得有人往 config 里塞垃圾把文件写炸。
  'POST /api/ui/theme': async (body) => {
    const preset = Number(body.preset);
    if (!Number.isInteger(preset) || preset < 0 || preset > 999) {
      throw new Error('preset 必须是 0 到 999 之间的整数');
    }
    let custom = null;
    if (body.custom && typeof body.custom === 'object' && !Array.isArray(body.custom)) {
      const out = {};
      for (const [k, v] of Object.entries(body.custom)) {
        if (typeof v === 'string' && v.length <= 64 && /^[-\w]+$/.test(k)) out[k] = v;
      }
      custom = Object.keys(out).length ? out : null;
    }
    const json = JSON.stringify({ preset, custom });
    if (json.length > 8192) throw new Error('配色数据太大');
    config.ui = { theme: { preset, custom } };
    await saveConfig();
    return { ok: true, preset, bytes: json.length };
  },

  'POST /api/skin/upload': async (body) => {
    // 接受 dataURL(data:image/png;base64,...) 或纯 base64
    const raw = String(body.data || '');
    if (!raw) throw new Error('没有图片数据');
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(raw);
    let ext = 'png';
    let b64 = raw;
    if (m) { ext = m[1] === 'jpeg' ? 'jpg' : m[1]; b64 = m[2]; }
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) throw new Error('图片解码失败');
    if (buf.length > 8 * 1024 * 1024) throw new Error('图片超过 8MB');
    await fsp.mkdir(SKINS_DIR, { recursive: true });
    const name = `skin-${Date.now()}.${ext}`;
    await fsp.writeFile(path.join(SKINS_DIR, name), buf);
    config.skin.active = `custom:${name}`;
    await saveConfig();
    log('ok', `皮肤已导入并启用: ${name} (${Math.round(buf.length / 1024)}KB)`);
    return { active: `custom:${name}`, url: `/api/skin/file/${name}` };
  },

  'POST /api/skin/delete': async (body) => {
    const id = String(body.id || '');
    if (!id.startsWith('custom:')) throw new Error('只能删自定义皮肤');
    const name = path.basename(id.slice('custom:'.length));
    const file = path.join(SKINS_DIR, name);
    if (fs.existsSync(file)) await fsp.unlink(file);
    if (config.skin.active === id) config.skin.active = 'default';
    await saveConfig();
    log('info', `皮肤已删除: ${name}`);
    return { active: config.skin.active };
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = `${req.method} ${url.pathname}`;

  // 自定义皮肤文件 (PNG/JPG/WEBP)
  if (req.method === 'GET' && url.pathname.startsWith('/api/skin/file/')) {
    const name = path.basename(url.pathname.slice('/api/skin/file/'.length));
    const file = path.join(SKINS_DIR, name);
    try {
      const buf = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch {
      res.writeHead(404).end('skin not found');
    }
    return;
  }

  // 静态文件: 打包 exe 时用内嵌资源, 源码模式优先读磁盘 public/
  // (以前一律优先内嵌, 导致改完 public/ 却看到旧页面, 开发时极易踩坑)
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const embedded = EMBED && (EMBED[rel] || EMBED['/' + rel]);
    const file = path.join(PUBLIC_DIR, rel);
    const inside = file.startsWith(PUBLIC_DIR);

    const sendEmbedded = () => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'text/plain; charset=utf-8' });
      res.end(embedded);
    };
    const sendDisk = async () => {
      const buf = await fsp.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(buf);
      return true;
    };

    if (!IS_PACKAGED && inside) {
      try {
        await sendDisk();
        return;
      } catch { /* 磁盘没有就退回内嵌 */ }
    }
    if (embedded) { sendEmbedded(); return; }
    if (inside) {
      try { await sendDisk(); return; } catch { /* 404 */ }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }

  // 日志轮询
  if (route === 'GET /api/logs') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJSON(res, 200, { logs: LOGS.filter((l) => l.seq > since), seq: logSeq, running });
    return;
  }

  // 任务历史(带 ?n= 限条数, 所以走特殊分支)
  if (route === 'GET /api/task/history') {
    const n = Number(url.searchParams.get('n') || 30);
    const limit = Number.isFinite(n) ? Math.min(200, Math.max(1, n)) : 30;
    sendJSON(res, 200, { history: recentHistory(limit), running, file: historyFilePath() });
    return;
  }

  // 终端轮询
  if (route === 'GET /api/term') {
    const since = Number(url.searchParams.get('since') || 0);
    sendJSON(res, 200, {
      lines: TERM.buf.filter((l) => l.seq > since),
      seq: TERM.seq,
      cwd: TERM.cwd,
      running: !!TERM.child,
    });
    return;
  }

  const handler = ROUTES[route];
  if (!handler) { sendJSON(res, 404, { error: `没有这个接口: ${route}` }); return; }
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const out = await handler(body);
    sendJSON(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    log('error', `${route} 出错: ${e.message}`);
    sendJSON(res, 500, { error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function parseCliArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--version' || a === '-v') {
      emitCli(`bili-studio ${VERSION}`);
      process.exit(0);
    }
    if (a === '--help' || a === '-h') {
      emitCli([
        `bili-studio ${VERSION} — B站养史控制台`,
        '',
        '用法: bili-studio [选项]',
        '',
        '选项:',
        '  --port=<端口>   换端口 (默认 8787), 也支持 --port 8899',
        '  --open          启动后自动用浏览器打开控制台 (exe 默认开启)',
        '  --no-open       启动后不自动开浏览器 (源码模式默认)',
        '  --version, -v   看版本',
        '  --help, -h      看这个帮助',
        '',
        `运行形态: ${IS_PACKAGED ? '打包 exe' : '源码(node)'}`,
        `数据目录: ${DATA_DIR}`,
        `日志文件: ${LOG_FILE}`,
      ].join('\n'));
      process.exit(0);
    }
    if (a === '--open') AUTO_OPEN = true;
    if (a === '--no-open') AUTO_OPEN = false;
    // 支持 --port=8899 和 --port 8899 两种写法
    if (a.startsWith('--port=')) {
      PORT = Number(a.slice('--port='.length)) || PORT;
    } else if (a === '--port') {
      PORT = Number(args[i + 1]) || PORT;
      i++;
    }
  }
}

// 注意: 这里刻意不用顶层 await —— Node SEA 对顶层 await 支持不稳,
// 打包成 exe 后可能不执行, 所以统一走 main().catch()。
async function main() {
  parseCliArgs();

  // 控制台窗口标题: 双击运行时一眼看出这是什么、怎么关
  try {
    process.title = `bili-studio v${VERSION} - http://${HOST}:${PORT} (关闭本窗口即停止服务)`;
  } catch { /* ignore */ }

  await loadConfig();
  loadHistory();   // v1.5.3: 把上次跑到一半前进度的历史读回来

  server.on('error', onServerError);
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    log('ok', `🐋 鲸鱼娘控制台已启动 (v${VERSION}): ${url}`);
    log('info', `账户 ${config.accounts.length} 个 / @名单 ${config.mentions.length} 人 / 定时任务 ${config.schedules.length} 个`);
    log('info', `AI 接口: ${config.ds.model} @ ${normalizeBaseUrl(config.ds.baseUrl)}`);
    log('info', `AI Key: ${dsKeyMem ? `${dsKeyMem.slice(0, 7)}***${dsKeyMem.slice(-4)}（来源: ${dsKeySource}）` : '未配置'}`);
    log(config.task.dryRun ? 'warn' : 'error',
      config.task.dryRun ? '当前是【干跑模式】: 只预览不发送' : '当前是【真实发送模式】: 按下去会真的发评论!');
    log('info', config.task.dm
      ? `发送方式: 【私信模式】${dmFormNow() === 'card' ? '原生卡片(被拒自动降级文字)' : '文本 + 链接'}`
      : '发送方式: 【评论模式】在视频评论区发言');
    log('info', `数据目录: ${DATA_DIR}`);
    // v1.5.3(P2-8): 把定时任务的排期说清楚 —— 以前只在到点时才有一行日志,
    // 主人根本不知道下一个任务什么时候跑、关了页面还算不算数。
    log('info', `定时排期: ${describeSchedules()}`);
    if (config.schedules.some((s) => s.enabled)) {
      log('info', '定时任务由服务本身执行, 关掉浏览器页面不影响 —— 要停就点右上角「关闭控制台」');
    }

    if (AUTO_OPEN) {
      const ok = openBrowser(url);
      log(ok ? 'ok' : 'warn', ok ? '已用默认浏览器打开控制台页面' : '自动打开浏览器失败, 请手动访问上面的地址');
    }
    startScheduler();
    installSingleInstanceGuard(server);
  });
}

main().catch((e) => {
  showFatalError(e);
  process.exit(1);
});
