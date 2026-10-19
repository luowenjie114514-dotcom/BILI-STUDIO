// 打包 Windows exe，零 npm 依赖：
//   1) 把 public/ 静态资源内嵌进 embed-assets.mjs
//   2) 把 server.mjs + 内嵌资源合成单文件 bundle（SEA 只接受单个脚本入口）
//   3) 用 node --experimental-sea-config 生成 blob
//   4) 复制 node.exe，再用 postject 的纯 JS 实现注入 blob
//
// postject 的 dist/api.js 把 wasm 以 base64 内嵌在 JS 里，所以完全不需要
// 原生 postject.exe，也不需要 npm install。
//
// 用法: node build.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE_EXE = process.execPath;

const BUILD_DIR = path.join(__dirname, 'build');
const DIST_DIR = path.join(__dirname, 'dist');
const BUNDLE = path.join(DIST_DIR, 'app.bundle.cjs');
const OUT_EXE = path.join(DIST_DIR, 'bili-studio.exe');
const SEA_BLOB = path.join(DIST_DIR, 'sea-prep.blob');
const SEA_CONFIG = path.join(DIST_DIR, 'sea-config.json');
const EMBED_FILE = path.join(__dirname, 'embed-assets.mjs');

const POSTJECT_VERSION = '1.0.0-alpha.6';
const POSTJECT_TARBALL = `https://registry.npmjs.org/postject/-/postject-${POSTJECT_VERSION}.tgz`;
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const ASSETS = ['index.html', 'app.js'];
// 项目根的文件: 不进 public/ 但 exe 里也要能读到(更新日志面板用)
const ROOT_ASSETS = ['CHANGELOG.md'];

const log = (...a) => console.log('[build]', ...a);

function fail(msg) {
  console.error('[build] 失败:', msg);
  process.exit(1);
}

/* ---------- 0) 前端分模块 -> 单个 app.js (v1.5.3, P2-10) ---------- */

/**
 * public/front/ 下有多个源片段, 按 manifest 顺序拼成 public/app.js。
 *
 * 为什么要拼: 前端是普通 <script>, 没有模块加载器(不用 bundler、不引 CDN),
 * 拆成多个文件会让浏览器发好几个请求、还要自己维护加载顺序。
 * 拼成一个文件后:
 *   - 源码按职责分开写(好读好改);
 *   - 浏览器和 exe 拿到的仍然是同一份 app.js;
 *   - 函数都是顶级声明, 共享同一个顶层作用域, 互相直接调用, 没有任何包装。
 *
 * manifest: public/front/manifest.txt, 一行一个文件名, # 开头是注释。
 */
const FRONT_DIR = path.join(__dirname, 'public', 'front');
const FRONT_MANIFEST = path.join(FRONT_DIR, 'manifest.txt');
const FRONT_OUT = path.join(__dirname, 'public', 'app.js');

async function buildFront() {
  if (!fs.existsSync(FRONT_MANIFEST)) {
    log('前端: 没有 front/manifest.txt, 直接用现有 public/app.js');
    return;
  }
  const raw = await fsp.readFile(FRONT_MANIFEST, 'utf8');
  const parts = raw.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  const chunks = [];
  const names = [];
  for (const name of parts) {
    const file = path.join(FRONT_DIR, name);
    if (!fs.existsSync(file)) fail(`前端片段不存在: public/front/${name}`);
    const text = (await fsp.readFile(file, 'utf8')).replace(/\s+$/, '');
    chunks.push(`/* ====== ${name} ====== */\n${text}`);
    names.push(name);
  }
  const out = `/* 鲸鱼娘控制台 · 前端逻辑\n * 由 build.mjs 从 public/front/*.js 拼接生成 —— 不要直接改这个文件,\n * 改 public/front/ 下的片段, 然后跑 node build.mjs 或点「构建前端」。\n */\n`
    + `${chunks.join('\n\n')}\n`;
  await fsp.writeFile(FRONT_OUT, out, 'utf8');
  log(`前端: ${names.length} 个片段 -> public/app.js (${out.length} 字节)`);
}

/* ---------- 0.5) 鲸鱼娘 SVG 内联进 index.html ---------- */

/**
 * 把 public/whale.svg 内联成 index.html 里的 <symbol id="whaleGirl">。
 *
 * 为什么不在 ASSETS 里多登记一个 .svg:
 *   1. `<img src>` 里的 SVG 不继承页面 CSS 变量, 换主题鲸鱼娘不会跟着变;
 *   2. 多一个静态资源就多一次 404 风险和一处打包漏嵌的机会。
 * 逻辑只有一份, 在 tools/inline-whale.mjs (单独也能跑), 这里直接调它。
 */
async function inlineWhale() {
  const out = spawnSync(process.execPath, [path.join(__dirname, 'tools', 'inline-whale.mjs')], {
    encoding: 'utf8', cwd: __dirname,
  });
  const text = ((out.stdout || '') + (out.stderr || '')).trim();
  if (text) console.log(text.split('\n').map((l) => '  ' + l).join('\n'));
}

/* ---------- 1) 内嵌静态资源 ---------- */

async function writeEmbedModule() {
  const lines = [];
  for (const f of ASSETS) {
    const text = await fsp.readFile(path.join(__dirname, 'public', f), 'utf8');
    lines.push(`EMBED[${JSON.stringify(f)}] = ${JSON.stringify(text)};`);
  }
  for (const f of ROOT_ASSETS) {
    const text = await fsp.readFile(path.join(__dirname, f), 'utf8');
    lines.push(`EMBED[${JSON.stringify(f)}] = ${JSON.stringify(text)};`);
  }
  const out = '// 自动生成: 内嵌 public/ 静态资源 (由 build.mjs 生成)\n'
    + 'export const EMBED = {};\n'
    + lines.join('\n') + '\n'
    + 'export default EMBED;\n';
  await fsp.writeFile(EMBED_FILE, out, 'utf8');
  log(`已内嵌资源: ${ASSETS.concat(ROOT_ASSETS).join(', ')} (${out.length} 字节)`);
  return lines.join('\n');
}

/* ---------- 2) 合成单文件 bundle ---------- */

// SEA 的入口是当 CommonJS 跑的(embedderRunCjs), 所以要把 server.mjs 的
// ESM 语法就地降级成 CJS。server.mjs 只有 7 个 import、零个 export, 直改最稳。
function toCjs(src) {
  let out = src;

  // import X from 'node:y'   ->  const X = require('node:y')
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2;?[ \t]*$/gm,
    'const $1 = require($2$3$2);',
  );

  // import { a, b as c } from 'node:y'  ->  const { a, b: c } = require('node:y')
  out = out.replace(
    /^import\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2;?[ \t]*$/gm,
    (_, names, q, mod) => `const {${names.replace(/\s+as\s+/g, ': ')}} = require(${q}${mod}${q});`,
  );

  // import 'node:y'  ->  require('node:y')
  out = out.replace(/^import\s+(['"])([^'"]+)\1;?[ \t]*$/gm, 'require($1$2$1);');

  // import.meta.url 在 CJS 里是语法错误, 换成等价的 file URL
  out = out.replace(/import\.meta\.url/g, "require('node:url').pathToFileURL(__filename).href");

  return out;
}

/* ---------- 2.5) 相对模块内联 ---------- */
/*
 * v1.6.0 把 server.mjs 拆成了 server/*.mjs 若干模块, 但 SEA 只接受单个脚本入口,
 * 且不能解析相对 import。所以打包时先把相对模块「就地展开」:
 *   import { a, b } from './server/util.mjs'   ->  那一整个模块的代码
 * 展开规则: 模块里 export 的东西挂到一个用模块名生成的命名空间对象上,
 * 再解构回来 —— 这样源码里写的 `import { x } from './x.mjs'` 在 bundle 里照样能用。
 * 顺序按依赖关系拓扑排, 被依赖的先展开。
 */

// 只认单层 server/ 目录, 不做递归依赖图(够用且好排查)
const MODULE_DIR = path.join(__dirname, 'server');

function collectModules() {
  if (!fs.existsSync(MODULE_DIR)) return [];
  return fs.readdirSync(MODULE_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort()
    .map((f) => ({ name: f.replace(/\.mjs$/, ''), file: path.join(MODULE_DIR, f) }));
}

/** 把一个模块的 ESM 改成「挂到命名空间对象上」的普通 JS */
function moduleToNamespace(src, nsName) {
  // 每个模块独立作用域: 顶层声明统一加模块名前缀, 避免内联后撞名
  // (util.mjs 的 sleep 和 bili.mjs 的 sleep 都会变成 __util_sleep / __bili_sleep)
  // 前缀必须能当标识符用: 模块名里若有 '-' (如 config-migrate), 会变成
  // `__config-migrate_` -> 被 JS 当减号解析, 报 "Missing initializer in const declaration"。
  const prefix = `__${nsName.replace(/-/g, '_')}_`;
  return (() => {
  let out = src;
  // 先把相对 import 记下来(模块之间也允许互相 import)
  const deps = [];
  // 从别的模块 import 进来的名字: 本地用带前缀的别名, 记住原名 -> 别名
  const importedNames = new Map();
  out = out.replace(
    /^import\s*\{([^}]+)\}\s*from\s*['"]\.\/([\w-]+)\.mjs['"];?[ \t]*$/gm,
    (_, names, dep) => {
      deps.push(dep);
      const pairs = names.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => {
          const [a, b] = s.split(/\s+as\s+/);
          const local = b || a;
          importedNames.set(local, `${prefix}${local}`);
          // 解构的键必须是**源模块导出的原名** a, 值才是本模块里的前缀别名。
          // 以前写成 `${a}: ${prefix}${local}` 是对的, 但外面那轮全局替换会把 a 也加上前缀,
          // 变成 `{__ai_sleep: __ai_sleep}` —— __mod_util 没有这个键, 运行时就是 undefined。
          return { key: a, alias: `${prefix}${local}` };
        });
      const body = pairs.map((p) => `${p.key}: ${p.alias}`).join(', ');
      return `const {${body}} = __mod_${dep};`;
    },
  );
  // import X from './x.mjs' —— 默认导出, 转成取 .default
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]\.\/([\w-]+)\.mjs['"];?[ \t]*$/gm,
    (_, def, dep) => {
      deps.push(dep);
      importedNames.set(def, `${prefix}${def}`);
      return `const ${prefix}${def} = __mod_${dep}.default;`;
    },
  );
  // export function foo(...) -> function foo(...) ; 收集名单
  const names = [];
  out = out.replace(/^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
    (_, a, n) => { names.push(n); return `${a || ''}function ${prefix}${n}`; });
  out = out.replace(/^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_, k, n) => { names.push(n); return `${k} ${prefix}${n}`; });
  // export { a, b as c }
  out = out.replace(/^export\s*\{([^}]+)\};?[ \t]*$/gm, (_, list) => {
    for (const s of list.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [a, b] = s.split(/\s+as\s+/);
      names.push(b ? `${a}: ${b}` : a);
    }
    return '';
  });
  if (/^\s*export\s/m.test(out)) {
    throw new Error(`模块 ${nsName} 里还有没处理的 export 语法`);
  }
  // 模块内部所有顶层 let/const/var 都要加前缀(不只是 export 的),
  // 否则 bili.mjs 里的 `let UA` 会和 server.mjs 的 `const UA` 撞名。
  // 只匹配行首声明, 不碰函数体里的局部变量。
  // 注意: 必须先把声明行整个跳过, 免得把已改好的 `const __util_sleep` 再改一遍成 `__util___util_sleep`。
  const topDecls = new Set();
  // 先收「Node 内置模块的 import」: `import fs from 'node:fs';` 没有 `=`,
  // declRe 根本匹配不到, 结果 history.mjs 的 `fs` 没加前缀, 内联后和 server.mjs
  // 的 `const fs = require('node:fs')` 直接撞名(SyntaxError: Identifier 'fs' has already been declared)。
  // 先把整个 import 语句抽出来放占位符, 免得**模块路径 'node:fs' 也被改名**,
  // 放回去之前顺手把名字换成带前缀的版本。
  const nodeImports = [];       // 本地名
  const nodeImportLines = [];   // 原始 import 语句
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2;?[ \t]*$/gm,
    (line, name) => {
      nodeImports.push(name);
      nodeImportLines.push(line);
      return `/*__NODEIMPORT_${nodeImports.length - 1}__*/`;
    },
  );
  // 注意: `=` 后面必须跟真正的赋值号, 不能把 `==` / `=>` 当赋值。
  // `const clamp = (v,a,b) => ...` 这种箭头函数里有两个 `=`, 用 [^=] 排除掉。
  const declRe = /^(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)/gm;
  let dm;
  while ((dm = declRe.exec(out))) {
    const n = dm[1];
    if (n.startsWith(prefix)) continue;      // 已改过
    topDecls.add(n);
  }
  for (const n of nodeImports) {
    const e = n.replace(/[$]/g, '\\$');
    out = out.replace(new RegExp(`(?<![\\w$.])${e}(?![\\w$])`, 'g'), `${prefix}${n}`);
  }
  // 把抽走的 import 语句放回去(名字已带前缀), toCjs 会再把它们改成 require
  out = out.replace(/\/\*__NODEIMPORT_(\d+)__\*\//g, (_, i) => {
    const k = Number(i);
    const name = nodeImports[k];
    const line = nodeImportLines[k];               // import fs from 'node:fs';
    // 只替换说明符(第一个词), 路径原样保留
    return line.replace(/^import\s+[A-Za-z_$][\w$]*/, `import ${prefix}${name}`);
  });
  for (const n of topDecls) {
    if (names.includes(n)) continue;         // export 的已在上面改好
    const e = n.replace(/[$]/g, '\\$');
    // 先把「行首声明」那一处改成带前缀的名字, 再把剩下所有裸引用一起改
    out = out.replace(
      new RegExp(`^(let|const|var)(\\s+)${e}(?![\\w$])`, 'gm'),
      (_, kw, sp) => `${kw}${sp}${prefix}${n}`,
    );
    out = out.replace(
      new RegExp(`(?<![\\w$.])${e}(?![\\w$])`, 'g'),
      `${prefix}${n}`,
    );
  }
  // 模块内部的互相调用也要跟着改名: 顶层声明的所有函数/常量统一加前缀
  // (只改本模块自己声明过的名字, 不碰关键字和局部变量)
  //
  // ⚠ 这里有个坑(1.5.3 打包后才暴露, 源码模式完全看不出来):
  //   形如 `function configureHistory({ file: f, log: l })` 的参数里, `file` / `log`
  //   是**对象属性键**, 不是标识符 —— 键名不该加前缀。全局替换会把它改成
  //   `{ __history_file: f }`, 而调用方 `configureHistory({ file: ... })` 在另一个文件里
  //   不会被改, 于是解构拿到 undefined, 历史文件路径永远是空串(writer.mjs 的 log 同款)。
  //   修法: 替换完再把**形参里**的 `__x_k: v` 还原成 `k: v`。
  //   只还原形参(紧跟 function 名后面那对括号), 不碰对象字面量 —— 字面量里的键本来就该被
  //   换成前缀, 那是本模块自己定义的常量。
  for (const n of names) {
    if (n.includes(':')) continue;
    const re = new RegExp(`(?<![\\w$.])${n.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
    out = out.replace(re, `${prefix}${n}`);
  }
  // import 进来的名字(外部模块的)也要改成带前缀的本地别名,
  // 否则和 server.mjs 的解构 / 别的模块撞名。
  // 注意: import 语句已经被上面写成了 `const {sleep: __ai_sleep} = __mod_util;`,
  // 键名 `sleep` 是源模块导出名, 绝不能在这里被替换。所以先把整条 const {...} = __mod_X;
  // 抽出来存占位符, 替换完再放回去 —— 比正则「修回来」可靠得多。
  const stashed = [];
  out = out.replace(/^const \{[^}]*\} = __mod_[\w$]+;[ \t]*$/gm, (m) => {
    stashed.push(m);
    return `/*__IMPORT_${stashed.length - 1}__*/`;
  });
  for (const [orig, alias] of importedNames) {
    const re = new RegExp(`(?<![\\w$.])${orig.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g');
    out = out.replace(re, alias);
  }
  out = out.replace(/\/\*__IMPORT_(\d+)__\*\//g, (_, i) => stashed[Number(i)]);
  // 形参里的属性键还原原名: `function foo({ __m_log: l })` -> `function foo({ log: l })`
  out = out.replace(
    /(\bfunction\s+[A-Za-z_$][\w$]*\s*\()([^)]*)(\))/g,
    (m, head, params, tail) =>
      head + params.replace(/\b__[\w$]+_(?=[\w$]+\s*[:,}])/g, '') + tail,
  );
  const ns = names.map((s) => {
    if (s.includes(':')) {
      const [orig, alias] = s.split(':').map((x) => x.trim());
      return `${orig}: ${prefix}${alias}`;
    }
    return `${s}: ${prefix}${s}`;
  }).join(', ');
  return { code: out, deps, tail: `const __mod_${nsName} = { ${ns} };` };
  })();
}

function inlineModules(src) {
  const mods = collectModules();
  if (!mods.length) return src;   // 还没拆模块时原样返回

  const byName = Object.fromEntries(mods.map((m) => [m.name, m]));
  const emitted = new Set();
  const chunks = [];
  const visiting = new Set();

  const emit = (name) => {
    if (emitted.has(name)) return;
    if (visiting.has(name)) throw new Error(`模块循环依赖: ${name}`);
    const m = byName[name];
    if (!m) throw new Error(`找不到模块 server/${name}.mjs`);
    visiting.add(name);
    const { code, deps, tail } = moduleToNamespace(fs.readFileSync(m.file, 'utf8'), name);
    for (const d of deps) emit(d);
    visiting.delete(name);
    emitted.add(name);
    chunks.push(`/* ---- server/${name}.mjs ---- */\n${code}\n${tail}`);
  };

  // server.mjs 顶层 import 了哪些相对模块, 就按需展开哪些
  let out = src;
  const re = /^import\s*(?:\{[^}]*\}|[A-Za-z_$][\w$]*)\s*from\s*['"]\.\/server\/([\w-]+)\.mjs['"];?[ \t]*$/gm;
  let hit;
  while ((hit = re.exec(src))) emit(hit[1]);
  if (!chunks.length) return src;

  // 把 server.mjs 里这些 import 行换掉: 保留「从命名空间解构」的形式
  out = out.replace(
    /^import\s*\{([^}]+)\}\s*from\s*['"]\.\/server\/([\w-]+)\.mjs['"];?[ \t]*$/gm,
    (_, names, mod) => {
      const pairs = names.split(',').map((s) => s.trim()).filter(Boolean)
        .map((s) => { const [a, b] = s.split(/\s+as\s+/); return b ? `${a}: ${b}` : a; });
      return `const {${pairs.join(', ')}} = __mod_${mod};`;
    },
  );
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]\.\/server\/([\w-]+)\.mjs['"];?[ \t]*$/gm,
    (_, def, mod) => `const ${def} = __mod_${mod}.default;`,
  );
  log(`已内联模块: ${[...emitted].join(', ')}`);
  return `${chunks.join('\n\n')}\n\n${out}`;
}

async function writeBundle(embedAssigns) {
  let src = await fsp.readFile(path.join(__dirname, 'server.mjs'), 'utf8');

  // SEA 不能解析相对模块, 把 embed-assets 的 import 就地展开
  const importRe = /^import\s*\{\s*EMBED\s*\}\s*from\s*['"]\.\/embed-assets\.mjs['"];?[ \t]*$/m;
  if (!importRe.test(src)) fail('在 server.mjs 里找不到 embed-assets 的 import 语句');
  src = src.replace(importRe, `const EMBED = {};\n${embedAssigns}`);

  // 去掉 shebang, 免得干扰 SEA 入口判定
  src = src.replace(/^#!.*\r?\n/, '');

  // v1.6.0: 先把 server/*.mjs 相对模块就地展开, 再做 CJS 降级
  src = inlineModules(src);

  src = toCjs(src);

  // 三重校验: CJS bundle 里不允许再有 ESM 语法残留
  const strayImport = src.match(/^\s*import\s+[^\n]*from\s*['"]/m);
  if (strayImport) fail(`bundle 里还有 import: ${strayImport[0].trim()}`);
  const strayExport = src.match(/^\s*export\s/m);
  if (strayExport) fail(`bundle 里还有 export: ${strayExport[0].trim()}`);
  const strayMeta = src.match(/import\.meta/);
  if (strayMeta) fail('bundle 里还有 import.meta');

  const header = '/* bili-studio 打包产物: 由 build.mjs 生成, 请勿手改 */\n'
    + '"use strict";\n';
  await fsp.mkdir(DIST_DIR, { recursive: true });
  await fsp.writeFile(BUNDLE, header + src, 'utf8');
  log(`已合成 CJS bundle: ${path.relative(__dirname, BUNDLE)} (${src.length} 字节)`);
}

/* ---------- 3) 生成 SEA blob ---------- */

function buildBlob() {
  fs.writeFileSync(SEA_CONFIG, JSON.stringify({
    main: BUNDLE,
    output: SEA_BLOB,
    disableExperimentalSEAWarning: true,
  }, null, 2), 'utf8');

  log('生成 SEA blob ...');
  const r = spawnSync(NODE_EXE, ['--experimental-sea-config', SEA_CONFIG], {
    cwd: __dirname, encoding: 'utf8',
  });
  if (r.status !== 0) fail(`sea-config 失败: ${r.stderr || r.stdout}`);
  if (!fs.existsSync(SEA_BLOB)) fail('blob 没有生成');
  log(`blob 就绪 (${fs.statSync(SEA_BLOB).size} 字节)`);
}

/* ---------- 4) 注入 ---------- */

async function fetchPostject() {
  const apiPath = path.join(BUILD_DIR, 'postject', 'package', 'dist', 'api.js');
  if (fs.existsSync(apiPath)) {
    log('postject 已缓存, 跳过下载');
    return apiPath;
  }

  log('下载 postject ...');
  const res = await fetch(POSTJECT_TARBALL, { redirect: 'follow' });
  if (!res.ok) fail(`下载 postject 失败: HTTP ${res.status}`);
  const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));

  const pkgDir = path.join(BUILD_DIR, 'postject');
  fs.mkdirSync(pkgDir, { recursive: true });
  for (const f of parseTar(tar)) {
    const out = path.join(pkgDir, f.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, f.data);
  }
  if (!fs.existsSync(apiPath)) fail('postject 包里没找到 dist/api.js');
  return apiPath;
}

// 极简 tar 解析: 只认普通文件
function parseTar(buf) {
  const files = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = readStr(header, 0, 100);
    const size = parseInt(readStr(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156]);
    const dataStart = off + 512;
    if ((type === '0' || type === '\0' || type === '') && name) {
      files.push({ name, data: Buffer.from(buf.subarray(dataStart, dataStart + size)) });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

function readStr(block, start, len) {
  let end = start;
  while (end < start + len && block[end] !== 0) end++;
  return block.subarray(start, end).toString('utf8');
}

async function injectBlob(apiPath) {
  const { inject } = require(apiPath);
  if (typeof inject !== 'function') fail('postject api.js 没有导出 inject');

  log('复制 node.exe -> 目标 exe ...');
  fs.copyFileSync(NODE_EXE, OUT_EXE);

  log('注入 blob ...');
  const blob = fs.readFileSync(SEA_BLOB);
  await inject(OUT_EXE, 'NODE_SEA_BLOB', blob, {
    overwrite: true,
    sentinelFuse: SENTINEL_FUSE,
  });
  const size = fs.statSync(OUT_EXE).size;
  log(`注入完成: ${path.relative(__dirname, OUT_EXE)} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

/* ---------- 5) 把 PE 子系统从 CONSOLE 改成 GUI ---------- */

/**
 * node.exe 是控制台程序(Subsystem=3), 双击会附带一个黑窗口。
 * 这里把 Optional Header 的 Subsystem 字段改成 2(GUI), Windows 就不再
 * 分配控制台 —— 双击后只剩浏览器页面, 像正经桌面软件。
 *
 * 代价: 进程没有 stdout, 所以 server.mjs 会把日志同时写进 data/exe.log,
 * 命令行参数(--version 等)的输出也会留一份到 data/cli-output.txt。
 *
 * 字段位置: PE签名(e_lfanew) + COFF头(20) + Optional Header 内偏移 0x44,
 * PE32 与 PE32+ 的 Subsystem 都在 0x44。
 */
function patchSubsystemToGui(exePath) {
  const buf = fs.readFileSync(exePath);

  const peOff = buf.readUInt32LE(0x3C);           // e_lfanew
  if (peOff <= 0 || peOff + 4 > buf.length) fail('e_lfanew 越界, 不是有效 PE');
  if (buf.toString('latin1', peOff, peOff + 4) !== 'PE\0\0') fail('找不到 PE 签名');

  const optOff = peOff + 24;                       // PE签名(4) + COFF头(20)
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x10B && magic !== 0x20B) {
    fail(`未知的 Optional Header 魔数 0x${magic.toString(16)}(应为 0x10b 或 0x20b)`);
  }

  const subOff = optOff + 0x44;
  const before = buf.readUInt16LE(subOff);
  if (before === 2) { log('子系统已经是 GUI, 跳过'); return; }
  if (before !== 3) fail(`子系统字段是 ${before}, 既不是 GUI(2) 也不是 CONSOLE(3), 不敢乱改`);

  buf.writeUInt16LE(2, subOff);
  fs.writeFileSync(exePath, buf);

  // 回读确认真的落盘了
  const after = fs.readFileSync(exePath).readUInt16LE(subOff);
  if (after !== 2) fail(`子系统改写失败, 回读得到 ${after}`);
  log('子系统 CONSOLE(3) -> GUI(2) ✔ (双击不再弹黑窗口)');
}

/* ---------- 主流程 ---------- */

async function main() {
  // 清掉上一次构建的陈旧产物, 避免 dist 里混着旧 bundle 造成误判
  if (fs.existsSync(DIST_DIR)) {
    for (const f of await fsp.readdir(DIST_DIR)) {
      if (/^app\.bundle\.(mjs|cjs|js)$/.test(f) || f === 'sea-prep.blob') {
        await fsp.unlink(path.join(DIST_DIR, f));
      }
    }
  }

  await buildFront();                      // 先把前端片段拼成 public/app.js
  await inlineWhale();                     // 再把 whale.svg 内联进 index.html
  const embedAssigns = await writeEmbedModule();
  await writeBundle(embedAssigns);
  buildBlob();
  const apiPath = await fetchPostject();
  await injectBlob(apiPath);
  patchSubsystemToGui(OUT_EXE);

  log('全部完成。自检:');
  const v = spawnSync(OUT_EXE, ['--version'], { encoding: 'utf8' });
  const out = (v.stdout || v.stderr || '').trim();
  if (out) {
    console.log('   --version ->', out);
  } else {
    // GUI 子系统没有控制台, 输出会被记到文件里
    const cliFile = path.join(DIST_DIR, 'data', 'cli-output.txt');
    const fromFile = fs.existsSync(cliFile) ? fs.readFileSync(cliFile, 'utf8').trim() : '(读不到)';
    console.log('   --version -> (GUI 子系统无控制台, 取自文件)', fromFile);
  }
}

main().catch((e) => { console.error('[build] 出错:', e); process.exit(1); });
