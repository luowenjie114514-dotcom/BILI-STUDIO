/* 验证: 只填"凭据名", 不粘 Key, 也能自动从 DSH 凭据读到 */
const PORT = process.argv[2] || '8899';
const B = `http://127.0.0.1:${PORT}`;
const post = (p, o) => fetch(B + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o || {}),
}).then((r) => r.json());

console.log('=== 场景1: 选 Fiime 预设 + 凭据名 OPCFIIME_API_KEY, 不粘 Key ===');
let s = await post('/api/settings', {
  ds: {
    baseUrl: 'https://opc.fiime.cn/api/model-service/v1',
    model: 'deepseek-v4-flash',
    authMode: 'bearer',
    endpoint: '',
    extraHeaders: '',
    apiKeyRef: 'OPCFIIME_API_KEY',
    apiKey: '',                      // 故意不填
  },
});
console.log('  Key 掩码 :', s.ds?.apiKeyMask || '(空)');
console.log('  来源     :', s.ds?.apiKeySource);
console.log('  凭据名   :', s.ds?.apiKeyRef);
console.log(`  ${s.ds?.apiKeyMask ? '✔ 自动读到了 Key' : '✖ 没读到'}`);

console.log('\n=== 场景2: 凭据名不存在 + Base URL 也无法推断, 应列出可用的名字 ===');
s = await post('/api/settings', {
  ds: { apiKeyRef: 'NOT_EXIST_KEY', apiKey: '', baseUrl: 'https://example.com/v1' },
});
console.log('  来源     :', s.ds?.apiKeySource);
console.log(`  ${/可用的是/.test(s.ds?.apiKeySource || '') ? '✔ 正确列出了可用凭据名' : '✖ 没列出来'}`);

console.log('\n=== 场景2b: 凭据名不存在但 Base URL 指向 Fiime, 应兜底自动匹配 ===');
s = await post('/api/settings', {
  ds: { apiKeyRef: 'NOT_EXIST_KEY', apiKey: '', baseUrl: 'https://opc.fiime.cn/api/model-service/v1' },
});
console.log('  来源     :', s.ds?.apiKeySource);
console.log(`  ${/自动匹配/.test(s.ds?.apiKeySource || '') ? '✔ 按 Base URL 兜底匹配成功' : '✖ 兜底没生效'}`);

console.log('\n=== 场景3: 换回 DEEPSEEK_API_KEY(那个失效的) ===');
s = await post('/api/settings', { ds: { apiKeyRef: 'DEEPSEEK_API_KEY', apiKey: '' } });
console.log('  Key 掩码 :', s.ds?.apiKeyMask || '(空)');
console.log('  来源     :', s.ds?.apiKeySource);
