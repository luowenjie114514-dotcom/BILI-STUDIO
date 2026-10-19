/**
 * 配置迁移链(v1.6.0 新增)。
 *
 * 为什么要这个东西:
 *   - 以前只有 loadConfig 里一段 migrateConfig(), 没有版本号 —— 谁也不知道手里的
 *     config.json 是哪一版写的, 只能靠零散的 if 猜。
 *   - 字段改名/搬家时, deepMerge 会把旧字段原样留着、新字段填默认值,
 *     结果是「看起来没坏, 实际设置被静默丢掉」。这类 bug 最难查, 因为不报错。
 *
 * 现在的规则:
 *   1. config.json 里固定有个 `schemaVersion`(整数)。缺省 = 0, 代表 v1.6.0 之前的老文件。
 *   2. MIGRATIONS 是从 N 到 N+1 的一串函数, 按顺序跑, 每一步只关心「上一版 → 这一版」。
 *   3. 迁移只做结构搬运, 不验证业务合法性(那是 normalizeConfig 的事)。
 *   4. 每一步都记日志, 出问题能看出停在哪一版。
 *
 * 新增一版的做法: 在 MIGRATIONS 末尾加 { to: N+1, describe, run(cfg) }, 同时把
 * DEFAULT_CONFIG 里的 schemaVersion 改成 N+1。用户下次启动就会自动跨过去。
 */

/** 当前配置版本。每次改结构就 +1, 并在下面补一条迁移。 */
export const SCHEMA_VERSION = 2;

/**
 * 迁移链。key 是「目标版本」, 从 SCHEMA_VERSION=1 往前都有。
 * run(cfg) 直接原地改 cfg, 返回 void; 想说明改了什么可以返回字符串。
 */
export const MIGRATIONS = [
  {
    to: 1,
    describe: '把散落的 if 迁移收拢成一条链, 并补上 schemaVersion',
    run(cfg) {
      // ---- 1) mid 统一成字符串(早期版本从接口直接存了数字) ----
      for (const key of ['accounts', 'mentions']) {
        for (const item of cfg[key] || []) {
          if (item && item.mid !== undefined && item.mid !== null && typeof item.mid !== 'string') {
            item.mid = String(item.mid);
          }
        }
      }
      // ---- 2) skin 结构保证是对象 ----
      if (!cfg.skin || typeof cfg.skin !== 'object' || Array.isArray(cfg.skin)) {
        cfg.skin = { active: 'default' };
      }
      // ---- 3) 私信正文字数上限缺省(1.5.1 引入) ----
      if (cfg.task && typeof cfg.task === 'object' && cfg.task.dmMaxChars === undefined) {
        cfg.task.dmMaxChars = 40;
      }
      // ---- 4) 视频来源 / 私信形态补默认 ----
      if (cfg.task && typeof cfg.task === 'object') {
        if (cfg.task.videoSource === undefined) cfg.task.videoSource = 'search';
        if (cfg.task.dmForm === undefined) cfg.task.dmForm = 'card';
        if (cfg.task.dmTitle === undefined) cfg.task.dmTitle = true;
      }
    },
  },
  {
    to: 2,
    describe: '新增 ui.theme(主题配色随配置存档)',
    run(cfg) {
      // 老文件没有 ui 字段: 补一个, 主题交给前端默认值
      if (!cfg.ui || typeof cfg.ui !== 'object' || Array.isArray(cfg.ui)) {
        cfg.ui = { theme: null };
      }
      if (cfg.ui.theme === undefined) cfg.ui.theme = null;
    },
  },
];

/**
 * 把读进来的原始配置迁到 SCHEMA_VERSION。
 * 返回 { config, applied: [描述...], from, to }
 */
export function migrateConfigChain(raw, { log = () => {}, fromVersion } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: raw, applied: [], from: 0, to: SCHEMA_VERSION };
  }
  const cfg = raw;
  // 关键: 版本号必须取**磁盘上原始文件**里的值, 不能用合并后的 cfg.schemaVersion。
  // 因为 DEFAULT_CONFIG 自己带 schemaVersion, deepMerge 会把它填进去,
  // 结果老文件看起来天生就是新版, 迁移链一步都不跑 —— 这正是 mid 没转成字符串的原因。
  let ver;
  if (fromVersion !== undefined) {
    ver = Number(fromVersion);
  } else {
    ver = Number(cfg.schemaVersion);
  }
  if (!Number.isFinite(ver) || ver < 0) ver = 0;
  const from = ver;
  const applied = [];

  for (const step of MIGRATIONS) {
    if (step.to <= ver) continue;
    if (step.to > SCHEMA_VERSION) break;
    try {
      const note = step.run(cfg);
      applied.push(note || step.describe);
      log('info', `配置迁移 ${step.to - 1} → ${step.to}: ${note || step.describe}`);
    } catch (e) {
      // 单步迁移炸了不能把整个配置陪葬 —— 记下来, 继续用剩下的
      log('error', `配置迁移到 v${step.to} 失败: ${e.message}（继续使用当前配置）`);
    }
    ver = step.to;
  }

  cfg.schemaVersion = SCHEMA_VERSION;
  return { config: cfg, applied, from, to: SCHEMA_VERSION };
}
