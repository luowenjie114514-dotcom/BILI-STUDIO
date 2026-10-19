/* 恢复脚本: 把账户/@名单/偏好重新写回控制台
 *
 * ⚠️ 下面的 cookie 是**假数据**, 只用来演示脚本怎么用。
 *    要真跑, 请从浏览器 F12 复制自己的 cookie 填进来, 别把真 cookie 提交进仓库。
 */
const B = 'http://127.0.0.1:8787';
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

const COOKIE = [
  'buvid3=FAKE-BUVID3-0000-0000-0000-0000000000000infoc',
  'SESSDATA=FAKE%2C0000000000%2C000000%2AFAKE_SESSDATA_REPLACE_WITH_YOUR_OWN',
  'bili_jct=00000000000000000000000000000000',
  'DedeUserID=000000000',
].join('; ');

(async () => {
  let r = await post('/api/accounts', { name: '笨蛋鲸鱼娘', cookieText: COOKIE });
  console.log('账户:', r.error ? 'FAIL ' + r.error : r.accounts.map((a) => a.uname + ' Lv' + a.level).join(', '));

  for (const u of ['Yaprussia', '道馆恶魔三鹰朝']) {
    r = await post('/api/mentions', { uname: u });
    console.log('@' + u + ':', r.error ? 'FAIL ' + r.error : 'ok');
  }

  r = await post('/api/settings', {
    contentPreference: '无厘头搞笑、抽象、面向年轻人的下饭消遣视频，播放量高、评论区活跃',
    stylePreference: '暖一点，像小鲸鱼撒娇，简短自然，不要书面语',
    signature: '笨蛋鲸鱼娘',
    keywords: ['抽象', '无厘头', '搞笑', '下饭', '沙雕'],
  });
  console.log('偏好+署名+关键词:', r.error ? 'FAIL ' + r.error : 'ok');

  r = await fetch(B + '/api/state').then((x) => x.json());
  console.log('--- 最终状态 ---');
  console.log('账户:', r.accounts.map((a) => a.uname + '(Lv' + a.level + ',hasCookie=' + a.hasCookie + ')').join(', '));
  console.log('@名单:', r.mentions.map((m) => '@' + m.uname + '/' + m.mid).join(' '));
  console.log('关键词:', JSON.stringify(r.keywords));
  console.log('署名:', r.signature, '| 干跑:', r.task.dryRun);
  console.log('DS key:', r.ds.apiKeyMask, '来源:', r.ds.apiKeySource);
})().catch((e) => console.log('异常:', e.message));
