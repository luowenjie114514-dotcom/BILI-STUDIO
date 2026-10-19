// 把主人新给的 Yaprussia cookie 写进两个 config.json（源码模式 + exe 模式各一份）
import fs from 'node:fs';

const raw = fs.readFileSync('.cookie-tmp.txt', 'utf8').trim();
const pick = (k) => {
  const m = raw.match(new RegExp('(?:^|;\\s*)' + k + '=([^;]*)'));
  return m ? m[1] : '';
};
const sessdata = pick('SESSDATA');
const biliJct = pick('bili_jct');
const buvid3 = pick('buvid3');
const mid = pick('DedeUserID');
if (!sessdata || !biliJct || !mid) throw new Error('cookie 里缺 SESSDATA / bili_jct / DedeUserID');

const acc = {
  id: 'acc' + Date.now(),
  name: 'Yaprussia',
  sessdata,
  biliJct,
  buvid3,
  dedeUserId: mid,
  uname: 'Yaprussia',
  mid,
  level: 6,
  addedAt: Date.now(),
};

for (const p of ['data/config.json', 'dist/data/config.json']) {
  const c = JSON.parse(fs.readFileSync(p, 'utf8'));
  // 已经存在同 mid 的就更新凭据, 否则新增
  const hit = (c.accounts || []).find((a) => String(a.mid) === String(mid));
  if (hit) {
    Object.assign(hit, { sessdata, biliJct, buvid3, level: 6, name: 'Yaprussia', uname: 'Yaprussia' });
    console.log(`${p}: 更新已有账户 Yaprussia`);
  } else {
    c.accounts = c.accounts || [];
    c.accounts.push(acc);
    console.log(`${p}: 新增账户 Yaprussia (mid=${mid})`);
  }
  // 切换成这个账户
  c.activeAccountId = c.accounts.find((a) => String(a.mid) === String(mid)).id;
  fs.writeFileSync(p, JSON.stringify(c, null, 2), 'utf8');
  console.log(`  账户数=${c.accounts.length} 当前=${c.accounts.find((a) => a.id === c.activeAccountId).uname}`);
}
