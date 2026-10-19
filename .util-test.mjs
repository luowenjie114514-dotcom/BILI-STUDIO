import { countChars, clipChars, deepMerge, parseBvid, decodeEntities } from "./server/util.mjs";
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.log("FAIL " + m, JSON.stringify(a), "!=", JSON.stringify(b)); process.exitCode = 1; } else console.log("ok   " + m); };
eq(countChars("你好 世界"), 4, "countChars 去空白");
eq(countChars("🐋鱼"), 2, "countChars emoji 算 1");
const r1 = clipChars("这是一个很长很长的句子，需要被截断处理。后半截不要了", 12);
eq(r1.clipped, true, "clipChars 触发截断");
if ([...r1.text].length > 12) { console.log("FAIL 超长", r1.text); process.exitCode = 1; }
const r2 = clipChars("短句", 10);
eq([r2.text, r2.clipped], ["短句", false], "clipChars 不超长原样返回");
eq(deepMerge({ a: 1, b: { c: 2 } }, { b: { c: null, d: 3 } }), { a: 1, b: { c: 2, d: 3 } }, "deepMerge 忽略 null");
eq(deepMerge({ a: 1 }, null), { a: 1 }, "deepMerge null 基座不崩");
eq(parseBvid("https://www.bilibili.com/video/BV1xx411c7mD?p=1"), "BV1xx411c7mD", "parseBvid");
eq(decodeEntities("<em>哈</em>哈&amp;哟"), "哈哈&哟", "decodeEntities");
console.log(process.exitCode ? "\n有 FAIL" : "\n全部通过");
