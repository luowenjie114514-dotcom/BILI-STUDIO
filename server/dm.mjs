/**
 * B 站私信发送层。
 *
 * 只管一件事: 把一个已经写好的字符串送到某个 mid 的私信箱里。
 * 不管正文怎么来的 —— 那是 ai-writer / 业务层的事。
 */

import { biliCookie, normalizePic, reqJSON } from './bili.mjs';

/**
 * web 端发私信。
 *
 * 官方文档写「此接口仅支持 msg_type 1 / 2 / 5」, 但真实客户端确实能发视频分享卡片(7)。
 * 所以这里不猜也不去匹配错误文案 —— 卡片先试, 只要服务端 Code!=0 就降级成纯文字,
 * 逻辑上等价于"能用卡片就用卡片"。
 */
export const DM_ERRORS = {
  '-101': '账号未登录: cookie 过期了, 去「账户」页重新粘一次',
  '-400': '请求参数不对(多半是 msg_type 或 content 结构)',
  '-3': '系统错误, 稍后再试',
  21007: '消息太长(上限 2000 字节)',
  21015: '这个号没绑手机号, B 站不允许发私信',
  21020: '发得太快, 停一会儿',
  21026: '不能给自己的号发私信',
  21035: '这类消息暂时发不出去',
  21037: '图片格式不对',
  21046: '今天发得太多了, 24 小时后再来',
  21047: '对方没关注、也没回复过你, 最多只能收 1 条',
  25003: '对方隐私设置里关了陌生人私信',
  25005: '你把对方拉黑了, 先解除',
};

let log = () => {};
const configureDm = ({ log: logFn }) => {
  if (typeof logFn === 'function') log = logFn;
};

export async function biliSendMsg({ acc, receiverMid, msgType, content }) {
  if (!acc?.sessdata || !acc?.biliJct) {
    throw new Error('账户缺少 SESSDATA 或 bili_jct, 无法发私信');
  }
  const selfUid = String(acc.mid || acc.dedeUserId || '');
  if (!selfUid) throw new Error('账户缺少自己的 mid, 先去「账户」页点一次「测活」');
  if (selfUid === String(receiverMid)) throw new Error('不能给自己发私信');

  const form = {
    'msg[sender_uid]': selfUid,
    'msg[receiver_id]': String(receiverMid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': String(msgType),
    'msg[msg_status]': '0',
    'msg[dev_id]': crypto.randomUUID().toUpperCase(),
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[new_face_version]': '1',
    'msg[content]': JSON.stringify(content),
    csrf: acc.biliJct,
    csrf_token: acc.biliJct,
    build: '0',
    mobi_app: 'web',
  };
  return await reqJSON('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
    method: 'POST',
    form,
    cookie: biliCookie(acc, true),
    headers: {
      Referer: 'https://message.bilibili.com/',
      Origin: 'https://message.bilibili.com',
    },
  });
}

/** 视频的规范链接 —— 私信降级成文字时要补上, 不然对方不知道说的是哪条视频 */
export function videoUrlOf(v) {
  return `https://www.bilibili.com/video/${v.bvid || ''}`;
}

/** 组装一张"视频分享卡片"的内容体(msg_type=7) */
export function buildShareCard(video, customTitle) {
  const title = String(customTitle || video.title || '').slice(0, 60);
  return {
    author: video.author || 'UP主',
    headline: title,
    id: Number(video.aid) || 0,
    source: 5,                        // 5 = 视频稿件
    thumb: normalizePic(video.pic),
    title,
    url: videoUrlOf(video),
    bvid: video.bvid,
  };
}

/**
 * 发一条私信: 尽量用原生卡片, 卡片被服务端拒了就降级成纯文字。
 * cardTitle: 卡片上显示什么标题 —— null 就用视频真名, 传字符串就用它(老行为: 用问候语)。
 * 返回 { ok, form, code, message, msgKey, fellBack }
 */
export async function sendDm({ acc, target, text, video, preferCard, cardTitle }) {
  const out = { ok: false, form: 'text', code: null, message: '', msgKey: null, fellBack: false };

  if (preferCard && video && video.bvid && video.aid) {
    let r = null;
    try {
      r = await biliSendMsg({
        acc,
        receiverMid: target.mid,
        msgType: 7,
        content: buildShareCard(video, cardTitle || ''),
      });
    } catch (e) {
      out.message = e.message;
      r = { code: 'ERR', message: e.message };
    }
    if (r && r.code === 0) {
      out.ok = true;
      out.form = 'card';
      out.code = 0;
      out.msgKey = r.data?.msg_key ?? null;
      return out;
    }
    // 服务端明确拒绝了卡片形态 -> 降级。其它错误(未登录/限流)也降级试一次,
    // 因为文字是更基础的形态, 能发就说明问题只在卡片上。
    out.fellBack = true;
    out.fellBackCode = r?.code ?? null;
    out.fellBackMessage = r?.message || out.message || '';
    // 降级成文字时把视频链接补上, 不然对方不知道说的是哪条视频
    if (video && video.bvid) text = `${text}\n${videoUrlOf(video)}`;
    log('warn', `卡片被拒(code=${out.fellBackCode} ${out.fellBackMessage}), 降级成纯文字+链接再试`);
  }

  const r2 = await biliSendMsg({ acc, receiverMid: target.mid, msgType: 1, content: { content: text } });
  out.code = r2.code;
  out.message = r2.message;
  if (r2.code === 0) {
    out.ok = true;
    out.form = 'text';
    out.msgKey = r2.data?.msg_key ?? null;
  }
  return out;
}

/** 把 DM_ERRORS 里的熟人话翻出来, 没有就返回原样 */
export function dmErrorText(code, message) {
  const key = String(code);
  return DM_ERRORS[key] ? `${DM_ERRORS[key]}（code=${key}）` : `${message || '未知错误'}（code=${code}）`;
}

export { configureDm };
