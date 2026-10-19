/**
 * 内容生成业务层。
 *
 * 这一层只负责「让 AI 写出该发的东西」，不碰 HTTP、不碰 B 站接口：
 *   - 偏好分析 → 搜索关键词
 *   - 评论正文(20 字以内)
 *   - 私信正文(转述口吻, 字数由 config.task.dmMaxChars 管)
 *   - 没配 key 时的本地兜底模板
 *
 * 配置从 setWriterContext 注入，避免这里直接读全局 config。
 */

import { dsChat, extractJsonObject } from './ai.mjs';
import { parseBvid } from './util.mjs';
import { biliVideoInfo, biliVideoSearch } from './bili.mjs';

let cfg = () => ({});
let log = () => {};

export function configureWriter({ getConfig, log: logFn }) {
  if (typeof getConfig === 'function') cfg = getConfig;
  if (typeof logFn === 'function') log = logFn;
}

/** 把主人的自然语言描述变成搜索关键词 + 风格要点 */
export async function dsAnalyzePreference() {
  const c = cfg();
  const prompt = `你是 B 站内容检索助手。用户这样描述他想找的视频:
"""${c.contentPreference || ''}"""
这样描述他希望评论的语气风格:
"""${c.stylePreference || ''}"""

请输出 JSON:
{
  "keywords": ["3到5个适合直接丢进B站搜索框的中文关键词, 不要带引号", ...],
  "contentSummary": "一句话概括他想要什么内容",
  "styleNotes": "3到5条具体的评论风格要点"
}`;
  const out = await dsChat([
    { role: 'system', content: '你只输出 JSON, 不要任何解释。' },
    { role: 'user', content: prompt },
  ], { json: true, temperature: 0.4 });
  // 用容错解析: 模型经常无视"不要解释"而包一层 ```json 围栏
  const parsed = extractJsonObject(out);
  if (!Array.isArray(parsed.keywords) || !parsed.keywords.length) {
    throw new Error('DS 没给出关键词');
  }
  return parsed;
}

/** 让 DS 参考风格写一条评论主体(不含 @ 和署名) */
export async function dsWriteGreeting(video, mentions) {
  const c = cfg();
  const atNames = mentions.map((m) => m.uname).join('、');
  const prompt = `给 B 站视频写一条评论主体。

视频信息:
- 标题: ${video.title}
- UP主: ${video.author}
- 播放: ${video.play}  点赞: ${video.like ?? '未知'}  评论数: ${video.reply ?? '未知'}
- 简介: ${(video.desc || video.description || '无').slice(0, 120)}

要 @ 的人: ${atNames || '(无)'}
评论风格要求: ${c.stylePreference || ''}

硬性规则:
1. 只写评论正文本身, 不要写 @昵称, 不要写署名, 不要引号, 不要解释。
2. 正文不超过 20 个字。
3. 内容要和这个视频相关, 像是真看过才留的言。
4. 不要用"这个视频"这种空话, 要具体一点或者带点梗。`;
  const out = await dsChat([
    { role: 'system', content: '你是熟悉 B 站评论区的网友, 说话自然口语化。只输出评论正文。' },
    { role: 'user', content: prompt },
  ], { temperature: 1.1 });
  return out.trim().replace(/^["'「]|["'」]$/g, '').replace(/\s+/g, ' ').slice(0, 40);
}

/** 没配 DS key 时的兜底: 本地模板 */
export function localGreeting(video, i) {
  const pool = [
    '这条笑死我了哈哈哈',
    '救命怎么这么好下饭',
    '刷到就停不下来了',
    '已三连这条真的太顶',
    '笑点精准命中我了',
    '留着吃饭时候看',
  ];
  return pool[i % pool.length];
}

/* ------------------------------------------------------------------ */
/* 私信内容                                                            */
/* ------------------------------------------------------------------ */

/**
 * 私信正文字数上限(不含 @昵称和署名), 由 config.task.dmMaxChars 管, 默认 40。
 * 中文里「字」基本等于可见字符。
 */
export function dmCharLimit() {
  const c = cfg();
  const n = Number(c.task?.dmMaxChars);
  if (!Number.isFinite(n) || n < 10) return 40;
  return Math.min(400, Math.round(n));
}

/**
 * 私信正文 —— v1.5.1 重写。
 *
 * 以前的写法是把视频标题/UP 塞进提示词, 再套一层「撒娇」风格, 结果 DS 一看到视频
 * 标题就开始表演对视频的情绪(「你也太懂我了吧」「本鱼看得心里复杂」), 主人生动地
 * 称之为「扭捏作态」。私信要的不是表演, 是**转述**:
 *   「这是插件发布视频, 他说判据还在改, 我觉得鱼太多就别发了」
 *   「这条就是给主人写的那个「替你刷B站」插件的介绍片! 最逗的是评论区……」
 * 也就是: 说清这条是什么 + 我看到了什么 + 我的判断, 只陈述, 不撒娇。
 */
export async function dsWriteDmGreeting(target, video) {
  const c = cfg();
  const persona = c.signature || '笨蛋鲸鱼娘';
  const maxChars = dmCharLimit();
  const info = video
    ? [
      `- 标题: ${video.title}`,
      `- UP主: ${video.author}`,
      `- 播放: ${video.play ?? '未知'}  弹幕: ${video.danmaku ?? '未知'}  评论数: ${video.reply ?? '未知'}`,
      `- 简介: ${(video.desc || video.description || '无').slice(0, 120)}`,
    ].join('\n')
    : '(这轮没拿到视频, 就说说自己今天在刷什么)';
  const prompt = `你要给一个 B 站用户发一条私信, 内容是「我今天刷到了什么」。

这条视频(你的素材):
${info}

对方昵称: ${target.uname}

这个私信要怎么写:
- 像朋友随口跟你讲一句「我刚刷到这个」, 说完就完了。
- 说清楚三件事里的一两件: 这条视频是干什么的 / 里面有哪个点值得说 / 你自己怎么看值不值得看。
- 视频标题和 UP 主只是素材来源, 不要复读标题, 更不要因为标题有趣就演一段反应。

反面例子(别写成这样):
- 「你也太懂我了吧」「本鱼看得心里复杂」「这条笑死我了, 太会了」—— 这些是在表演情绪, 不是在转述信息。

正面例子(照着这个语感):
- 「这是插件发布视频, 他说判据还在改, 我觉得鱼太多就别发了」
- 「这条是给主人写的那个「替你刷B站」插件的介绍片, 评论区一大半是别的 AI 在扮演鱼」

硬性规则:
1. 只写私信正文, 不要署名, 不要 @昵称, 不要引号, 不要解释, 不要换行。
2. 不超过 ${maxChars} 个字(不含署名), 宁短勿长。
3. 不要撒娇、不要卖萌、不要扭捏作态、不要约见面、不要要联系方式、不要提钱。
4. 口语, 可以有语气词, 但情绪要为内容服务, 不要为情绪而情绪。`;
  const out = await dsChat([
    { role: 'system', content: `你是「${persona}」, 只输出私信正文, 不要任何多余的话。` },
    { role: 'user', content: prompt },
  ], { temperature: 1.05 });
  return out.trim().replace(/^["'「]|["'」]$/g, '').replace(/\s+/g, ' ').slice(0, 400);
}

/** 没配 DS key 时的兜底: 本地私信模板（也是转述口吻, 不撒娇） */
export function localDmGreeting(target, video, i) {
  const t = video ? `《${String(video.title).slice(0, 18)}》` : '今天刷的';
  const pool = [
    `刚刷到${t}, 看着还行, 先记一笔`,
    `${t} 这条是 UP ${video?.author || '某位'} 发的, 我扫了一眼觉得可以`,
    `今天刷到${t}, 没啥大事, 就是随手说一句`,
    `${t} 我看了下, 不是非得看的那种`,
    `随手刷到${t}, 想到就跟你说一声`,
  ];
  return pool[i % pool.length];
}

/**
 * 私信模式下给卡片找个载体: 优先手动 BV, 否则按第一个关键词搜一条。
 * 拿不到也不算错 —— 卡片只是加分项, 没有就发纯文字。
 */
export async function pickCarrierVideo(acc) {
  const c = cfg();
  try {
    if (c.task?.videoSource === 'manual') {
      const bv = String(c.task?.manualBvids || '')
        .split(/[\s,，]+/).map(parseBvid).filter(Boolean)[0];
      return bv ? await biliVideoInfo(bv, acc) : null;
    }
    const kw = (Array.isArray(c.keywords) && c.keywords[0]) || '搞笑';
    const list = await biliVideoSearch(kw, 1, acc);
    const best = list
      .filter((v) => v.aid && v.bvid)
      .sort((a, b) => (b.play || 0) - (a.play || 0))[0];
    if (!best) return null;
    return best.pic ? best : await biliVideoInfo(best.bvid, acc);
  } catch (e) {
    log('warn', `给卡片找视频失败(不影响发私信): ${e.message}`);
    return null;
  }
}

/**
 * 私信形态: 'card' = 原生视频分享卡片(服务端拒绝时自动降级纯文字)
 *           'texturl' = 纯文字 + 视频链接
 */
export function dmFormNow() {
  const c = cfg();
  const f = String(c.task?.dmForm || 'card');
  return f === 'card' ? 'card' : 'texturl';
}
