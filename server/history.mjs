/**
 * 任务历史落盘(v1.5.3 新增, 解决 P2-9)。
 *
 * 以前历史只在一个内存数组 `TASK_HISTORY` 里, 最多 30 条, **一重启就全没了**。
 * 主人重启一次 exe, 昨天跑过什么、失败在哪条, 全查不到。
 *
 * 现在的做法: 每次任务结束追加一行 JSON 到 `data/history.jsonl`,
 * 启动时读回来填内存 —— 追加写, 不改整份文件, 所以断电最多丢最后一行。
 *
 * 为什么用 jsonl 而不是一个大 JSON 数组:
 *   - 追加写 O(1), 不用每次读出��份重写;
 *   - 一行坏了只跳过那一行, 不会整份解析失败;
 *   - 人肉也能看、能 grep。
 *
 * 滚动: 文件超过 MAX_BYTES 时把旧的一半挪到 `history.jsonl.1`(只留一份备份),
 * 免得跑一年长成几百兆。
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;   // 2 MB, 约两万条
const KEEP_IN_MEMORY = 200;          // 内存里留最近 200 条, 界面够用

let file = '';
let mem = [];
let log = () => {};

/** @param {{file:string, log?:Function}} opts */
export function configureHistory({ file: f, log: l }) {
  file = f;
  if (l) log = l;
}

/**
 * 启动时把历史读回内存。
 * 文件不存在 / 单行坏掉都不抛错 —— 历史读不出来不该阻止服务启动。
 */
export function loadHistory() {
  mem = [];
  if (!file) return mem;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') log('warn', `读历史文件失败(忽略): ${e.message}`);
    return mem;
  }
  let bad = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec === 'object' && rec.taskId) mem.push(rec);
    } catch { bad++; }
  }
  if (bad) log('warn', `历史文件里有 ${bad} 行坏了(已跳过)`);
  // 文件是旧的往前追加, 取最后 KEEP_IN_MEMORY 条, 最新的排前面
  if (mem.length > KEEP_IN_MEMORY) mem = mem.slice(-KEEP_IN_MEMORY);
  mem.reverse();
  if (mem.length) log('info', `历史已载入 ${mem.length} 条`);
  return mem;
}

function rollIfNeeded(size) {
  if (size < MAX_BYTES) return;
  try {
    const backup = `${file}.1`;
    try { fs.rmSync(backup, { force: true }); } catch { /* ignore */ }
    fs.renameSync(file, backup);
    log('info', '历史文件超过 2MB, 已滚动到 history.jsonl.1');
  } catch (e) {
    log('warn', `历史文件滚动失败(继续追加): ${e.message}`);
  }
}

/**
 * 追加一条任务记录。
 * 落盘失败只记一条 warn —— 写不进硬盘不能把任务本身判成失败。
 */
export function appendHistory(rec) {
  if (!rec || !rec.taskId) return;
  mem.unshift(rec);
  if (mem.length > KEEP_IN_MEMORY) mem.length = KEEP_IN_MEMORY;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    rollIfNeeded(size);
    fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  } catch (e) {
    log('warn', `历史写入失败(不影响任务结果): ${e.message}`);
  }
}

/** 给接口用: 最近 n 条(新的在前) */
export function recentHistory(n = 30) {
  return mem.slice(0, Math.max(1, Number(n) || 30));
}

export function clearHistory() {
  mem = [];
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}.1`, { force: true });
  } catch (e) {
    log('warn', `清空历史失败: ${e.message}`);
  }
}

export function historyFilePath() {
  return file;
}
