/* 解析器单测: 验证各种"整串"输入形态 */
const COOKIE_KEYS = [
  'SESSDATA', 'bili_jct', 'buvid3', 'buvid4', 'buvid_fp', 'DedeUserID',
  'DedeUserID__ckMd5', 'b_nut', '_uuid', 'bili_ticket', 'sid', 'rpdid',
];

function parseCredentialText(raw) {
  const text = String(raw || '');
  const out = { found: [] };
  for (const key of COOKIE_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[\\s;"\\n])' + escaped + '\\s*[:=]\\s*"?(.*?)(?:"?\\s*(?:;|\\r?\\n|$))', 'i');
    const m = re.exec(text);
    if (m && m[2] !== undefined) {
      let val = m[2].trim().replace(/[;"']+$/, '');
      if (val) {
        out[key] = val;
        out.found.push(key);
      }
    }
  }
  return out;
}

const cases = [
  '纯cookie(标准)',
  'SESSDATA=abc%2C1234567890; bili_jct=893d06fa; buvid3=30B48355-F8CF; DedeUserID=1234567890',
  '请求头原文(带冒号)',
  'Cookie: SESSDATA=abc%2C123; bili_jct=zzz\nUser-Agent: Mozilla/5.0\nReferer: https://www.bilibili.com/\nbuvid3=AAA-BBB',
  '带引号',
  'SESSDATA="abc"; bili_jct="xyz"; buvid3=QQQ',
  '跨行+多余空格',
  'SESSDATA=abc\nbili_jct=xyz\nbuvid3=PPP',
];

for (let i = 0; i < cases.length; i += 2) {
  const label = cases[i];
  const input = cases[i + 1];
  const r = parseCredentialText(input);
  console.log('===', label);
  console.log('  found:', r.found.join(', '));
  console.log('  SESSDATA :', JSON.stringify(r.SESSDATA));
  console.log('  bili_jct :', JSON.stringify(r.bili_jct));
  console.log('  buvid3   :', JSON.stringify(r.buvid3));
  console.log('  DedeUserID:', JSON.stringify(r.DedeUserID));
}
