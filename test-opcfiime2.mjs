/* 拉完整模型列表 + 带退避重试地测聊天接口 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY = /^\s*OPCFIIME_API_KEY:\s*(\S+)\s*$/m
  .exec(fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8'))[1];
const BASE = 'https://opc.fiime.cn/api/model-service/v1';
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

// 1) 完整模型列表
const res = await fetch(`${BASE}/models`, { headers: H, signal: AbortSignal.timeout(30000) });
const j = await res.json();
console.log(`=== 可用模型 (${j.data?.length || 0} 个) ===`);
for (const m of j.data || []) {
  const caps = (m.capabilities || []).join(',');
  console.log(`  ${m.id.padEnd(22)} enabled=${m.enabled} type=${m.type || '-'} caps=${caps}`);
}
const ids = (j.data || []).map((m) => m.id);
console.log(`\n要用的两个模型是否在列表里: deepseek-v4-flash=${ids.includes('deepseek-v4-flash')} deepseek-v4-pro=${ids.includes('deepseek-v4-pro')}\n`);

// 2) 聊天接口: 带退避重试
async function chat(model, extra = {}, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '只回复两个字: 在线' }], ...extra }),
        signal: AbortSignal.timeout(60000),
      });
      const t = await r.text();
      let brief = t.slice(0, 300);
      try {
        const p = JSON.parse(t);
        if (p?.choices?.[0]?.message?.content) brief = `content=${JSON.stringify(String(p.choices[0].message.content).slice(0, 100))}`;
        else if (p?.error) brief = `${p.error.code || ''} ${p.error.message || ''}`.trim();
      } catch { /* 原文 */ }
      console.log(`  第 ${i} 次: HTTP ${r.status} | ${brief}`);
      if (r.ok) return true;
      // 只对"过载/限流"重试
      if (![429, 500, 502, 503, 504].includes(r.status)) return false;
    } catch (e) {
      console.log(`  第 ${i} 次: 异常 ${e.message}`);
    }
    if (i < tries) {
      const wait = i * 3;
      console.log(`  ...${wait}s 后重试`);
      await new Promise((s) => setTimeout(s, wait * 1000));
    }
  }
  return false;
}

console.log('=== 聊天接口 (deepseek-v4-flash) ===');
const okFlash = await chat('deepseek-v4-flash');
console.log(`\n=== 聊天接口 (deepseek-v4-pro) ===`);
const okPro = await chat('deepseek-v4-pro');

console.log(`\n=== 结论 ===`);
console.log(`deepseek-v4-flash: ${okFlash ? '可用' : '当前不可用(过载)'}`);
console.log(`deepseek-v4-pro  : ${okPro ? '可用' : '当前不可用(过载)'}`);
