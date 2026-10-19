/* 鲸鱼娘控制台 · 前端逻辑 */
'use strict';


/* 基础工具 / 状态渲染 / 各分区动作 / 启动 */
let S = null;          // 服务端配置快照
let logSeq = 0;        // 已拉取的日志序号
let pollTimer = null;
const AI_PRESETS = [
  { id: 'opcfiime', name: 'Fiime / opc.fiime.cn（本机默认）', baseUrl: 'https://opc.fiime.cn/api/model-service/v1', model: 'deepseek-v4-flash', keyRef: 'OPCFIIME_API_KEY' },
  { id: 'opcfiime-pro', name: 'Fiime / deepseek-v4-pro', baseUrl: 'https://opc.fiime.cn/api/model-service/v1', model: 'deepseek-v4-pro', keyRef: 'OPCFIIME_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyRef: 'DEEPSEEK_API_KEY' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyRef: 'OPENAI_API_KEY' },
  { id: 'moonshot', name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', keyRef: 'MOONSHOT_API_KEY' },
  { id: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', keyRef: 'ZHIPU_API_KEY' },
  { id: 'qwen', name: '阿里通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', keyRef: 'DASHSCOPE_API_KEY' },
  { id: 'siliconflow', name: '硅基流动 SiliconFlow', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', keyRef: 'SILICONFLOW_API_KEY' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', keyRef: 'OPENROUTER_API_KEY' },
  { id: 'ollama', name: '本地 Ollama（免鉴权）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', authMode: 'none' },
  { id: 'lmstudio', name: '本地 LM Studio（免鉴权）', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', authMode: 'none' },
  { id: 'oneapi', name: '自建 one-api / new-api', baseUrl: 'http://127.0.0.1:3000/v1', model: 'gpt-4o-mini' },
];
// 皮肤 = 换背景光斑。颜色全部走主题变量, 这样「换皮肤不毁主题」。
// default 用 var(--bg) 那套, 等于交给主题完全接管。
const PRESET_GRADIENTS = {
  default: 'radial-gradient(1200px 600px at 15% -10%, var(--bg-glow1) 0%, transparent 60%),radial-gradient(900px 500px at 100% 0%, var(--bg-glow2) 0%, transparent 55%),linear-gradient(180deg,var(--bg),var(--bg-deep) 70%)',
  ocean: 'radial-gradient(1200px 700px at 20% -10%, #0a5a7d 0%, transparent 60%),radial-gradient(900px 600px at 100% 10%, #123a63 0%, transparent 55%),linear-gradient(180deg,#03141f,#020a12 75%)',
  sakura: 'radial-gradient(1000px 600px at 80% -10%, #7a3d5d 0%, transparent 60%),radial-gradient(800px 500px at 10% 0%, #5c2a4a 0%, transparent 55%),linear-gradient(180deg,#1b0f1a,#0e0710 75%)',
  dark: 'linear-gradient(180deg,#05080c,#020407 80%)',
};

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function toast(msg, kind = '') {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function guard(fn) {
  try { await fn(); }
  catch (e) { toast('✖ ' + e.message, 'err'); }
}

function applyState(s) {
  S = s;

  // 顶栏
  const ver = document.getElementById('verBadge');
  if (ver) ver.textContent = 'v' + (s.version || '?');
  const mode = document.getElementById('modeBadge');
  const dmOn = !!s.task.dm;
  mode.textContent = (s.task.dryRun ? '干跑模式（不发）' : '真实发送模式')
    + (dmOn ? (s.task.dmForm === 'card' ? ' · 私信卡片' : ' · 私信文字+链接') : '');
  mode.className = 'badge ' + (s.task.dryRun ? 'dry' : 'dead');
  const active = s.accounts.find((a) => a.id === s.activeAccountId) || s.accounts[0];
  document.getElementById('accBadge').textContent = active
    ? `账户：${active.uname || active.name}（Lv${active.level ?? '?'}）`
    : '无账户';
  document.getElementById('todayStat').textContent =
    `今日已发 ${s.stats.postedToday} / 上限 ${s.task.dailyLimit} 条`;

  // 表单(只在没焦点时回填, 免得打字被打断)
  const fill = (id, val) => {
    const el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = val ?? '';
  };
  fill('contentPref', s.contentPreference);
  fill('stylePref', s.stylePreference);
  fill('signature', s.signature);
  fill('videoSource', s.task.videoSource);
  fill('videosPerRun', s.task.videosPerRun);
  fill('delaySeconds', s.task.delaySeconds);
  fill('searchPages', s.task.searchPages);
  fill('dailyLimit', s.task.dailyLimit);
  fill('manualBvids', s.task.manualBvids);
  fill('dsModel', s.ds.model);
  fill('dsBase', s.ds.baseUrl);
  fill('dsAuthMode', s.ds.authMode || 'bearer');
  fill('dsEndpoint', s.ds.endpoint);
  fill('dsExtraHeaders', s.ds.extraHeaders);
  fill('dsKeyRef', s.ds.apiKeyRef || 'DEEPSEEK_API_KEY');
  const status = document.getElementById('dsStatus');
  if (status) {
    status.innerHTML = s.ds.apiKeyMask
      ? `🔑 当前 Key：<b>${esc(s.ds.apiKeyMask)}</b><br><span class="kv">来源：${esc(s.ds.apiKeySource || '未知')}</span>`
      : '<span style="color:#ffc857">⚠ 还没配置 Key（可以在下面填一个；本地免鉴权服务请把鉴权方式选 none）</span>';
  }
  if (!document.getElementById('dryRun').matches(':focus')) {
    document.getElementById('dryRun').checked = !!s.task.dryRun;
  }
  const dmEl = document.getElementById('dmMode');
  if (dmEl && document.activeElement !== dmEl) dmEl.checked = !!s.task.dm;
  const form = s.task.dmForm === 'card' ? 'card' : 'texturl';
  document.querySelectorAll('input[name=dmForm]').forEach((r) => {
    if (document.activeElement !== r) r.checked = r.value === form;
  });
  const dmTitleEl = document.getElementById('dmTitle');
  if (dmTitleEl && document.activeElement !== dmTitleEl) {
    dmTitleEl.checked = s.task.dmTitle !== false;
  }
  const dmCharsEl = document.getElementById('dmMaxChars');
  if (dmCharsEl && document.activeElement !== dmCharsEl) {
    dmCharsEl.value = String(s.task.dmMaxChars || 40);
  }

  renderAccounts(s);
  renderMentions(s);
  renderSchedules(s);
}

/**
 * 空状态占位: 一只半透明的鲸鱼娘 + 一句话。
 * 为什么抽成函数: 账户 / 名单 / 定时 / 历史 四处都要用, 各写一遍容易漏。
 * 鲸鱼娘是 index.html 里的 <symbol id="whaleGirl">, 用 <use> 引用, 不额外请求资源。
 */
function whaleEmpty(text) {
  return `<div class="empty">`
    + `<svg class="whale-empty" viewBox="0 0 200 200" aria-hidden="true"><use href="#whaleGirl"/></svg>`
    + `<div>${esc(text)}</div></div>`;
}

function renderAccounts(s) {
  const box = document.getElementById('accList');
  if (!s.accounts.length) { box.innerHTML = whaleEmpty('还没有账户，先加一个吧'); return; }
  box.innerHTML = s.accounts.map((a) => {
    const h = a.health || null;
    const when = h && h.checkedAt ? new Date(h.checkedAt).toLocaleString('zh-CN') : '';
    let dot = '<span class="acc-dot unknown" title="还没验过活，点「测活」"></span>';
    if (h) {
      if (h.ok) dot = `<span class="acc-dot ok" title="登录正常 · ${esc(when)}"></span>`;
      else if (h.networkError) dot = `<span class="acc-dot warn" title="验活时网络异常 · ${esc(when)}"></span>`;
      else dot = `<span class="acc-dot bad" title="cookie 已失效：${esc(String(h.code ?? '-'))} ${esc(h.message || '')} · ${esc(when)}"></span>`;
    }
    return `
    <div class="item ${a.id === s.activeAccountId ? 'active' : ''}">
      <div class="grow">
        <div class="t">${dot}${esc(a.uname || a.name)} ${a.id === s.activeAccountId ? '<span class="pill on">使用中</span>' : ''}</div>
        <div class="s">mid=${esc(a.mid || '?')} · Lv${a.level ?? '?'} · cookie ${a.hasCookie ? '已保存' : '<span style="color:#ff6b6b">不完整</span>'}${h && !h.ok && !h.networkError ? ' · <span style="color:#ff6b6b">已失效，重新粘贴</span>' : ''}</div>
      </div>
      <button class="sm" onclick="testAccount('${a.id}')">测活</button>
      <button class="sm" onclick="activateAccount('${a.id}')">用它</button>
      <button class="sm danger" onclick="deleteAccount('${a.id}')">删</button>
    </div>`;
  }).join('');
}

/** 一次验活所有账户，页面打开时跑一次（失败不刷屏） */
async function checkAllAccounts(manual) {
  try {
    const r = await api('/api/accounts/health', {});
    if (r.config) applyState(r.config);
    if (manual) {
      const bad = (r.accounts || []).filter((x) => !x.ok && !x.networkError).length;
      toast(bad ? `${bad} 个账户 cookie 已失效` : '所有账户登录正常', bad ? 'err' : 'ok');
    }
  } catch (e) {
    if (manual) toast('验活失败: ' + e.message, 'err');
  }
}

function renderMentions(s) {
  const box = document.getElementById('menList');
  if (!s.mentions.length) { box.innerHTML = '<div class="kv">名单是空的</div>'; return; }
  box.innerHTML = s.mentions.map((m) => `
    <div class="item">
      <input type="checkbox" style="width:auto" ${m.enabled ? 'checked' : ''}
             onchange="toggleMention('${m.id}', this.checked)">
      <div class="grow">
        <div class="t">@${esc(m.uname)}</div>
        <div class="s">mid=${esc(m.mid)}${m.fans !== undefined ? ' · 粉丝 ' + m.fans : ''}${m.note ? ' · ' + esc(m.note) : ''}</div>
      </div>
      <button class="sm danger" onclick="deleteMention('${m.id}')">删</button>
    </div>`).join('');
}

function renderSchedules(s) {
  const box = document.getElementById('schList');
  if (!s.schedules.length) { box.innerHTML = whaleEmpty('还没有自动任务'); return; }
  box.innerHTML = s.schedules.map((x) => `
    <div class="item">
      <div class="grow">
        <div class="t">${esc(x.name)} <span class="pill ${x.enabled ? 'on' : 'off'}">${x.enabled ? '启用' : '停用'}</span>
          <span class="pill">${x.dryRun ? '干跑' : '真发'}</span>
          <span class="pill">${x.dm ? '私信' : '评论'}</span></div>
        <div class="s">${x.mode === 'interval'
          ? `每 ${x.everyMinutes} 分钟 · 每次 ${x.videosPerRun} ${x.dm ? '人' : '条'}`
          : `闹钟 ${esc(x.clockDate || '每天')} ${esc(x.clockAt)}${x.repeatDaily ? ' · 每天重复' : ' · 仅一次'}`}
          ${x.nextRun ? ' · 下次 ' + new Date(x.nextRun).toLocaleString('zh-CN') : ''}</div>
      </div>
      <button class="sm" onclick="toggleSchedule('${x.id}', ${x.enabled ? 'false' : 'true'})">
        ${x.enabled ? '停用' : '启用'}</button>
      <button class="sm danger" onclick="deleteSchedule('${x.id}')">删</button>
    </div>`).join('');
}

async function addAccount() {
  await guard(async () => {
    const cookieText = document.getElementById('accCookie').value.trim();
    if (!cookieText) throw new Error('先粘 cookie / 请求头');
    const s = await api('/api/accounts', {
      name: document.getElementById('accName').value.trim() || '我的账户',
      cookieText,
    });
    document.getElementById('accCookie').value = '';
    applyState(s);
    const acc = s.accounts[s.accounts.length - 1];
    const fields = (s.parsedFields || []).join('、');
    toast(`✔ 账户已添加：${acc.uname || acc.name} Lv${acc.level ?? '?'}${fields ? `\n识别到字段：${fields}` : ''}`, 'ok');
  });
}

async function testAccount(id) {
  await guard(async () => {
    const r = await api('/api/accounts/test', { id });
    applyState(r.config);
    toast(r.nav.ok ? `✔ 登录正常：${r.nav.uname} Lv${r.nav.level}` : `✖ ${r.nav.code} ${r.nav.message}`,
      r.nav.ok ? 'ok' : 'err');
  });
}

async function activateAccount(id) {
  await guard(async () => applyState(await api('/api/accounts/activate', { id })));
}

async function deleteAccount(id) {
  if (!confirm('确定删掉这个账户的 cookie？')) return;
  await guard(async () => applyState(await api('/api/accounts/delete', { id })));
}

async function addMention() {
  await guard(async () => {
    const uname = document.getElementById('mUname').value.trim();
    const mid = document.getElementById('mMid').value.trim();
    if (!uname && !mid) throw new Error('填个昵称');
    const s = await api('/api/mentions', { uname, mid });
    document.getElementById('mUname').value = '';
    document.getElementById('mMid').value = '';
    applyState(s);
    toast('✔ 已加入 @ 名单', 'ok');
  });
}

async function resolveUser() {
  await guard(async () => {
    const kw = document.getElementById('mUname').value.trim();
    if (!kw) throw new Error('先填昵称');
    const r = await api('/api/mentions/resolve', { keyword: kw });
    const box = document.getElementById('searchResult');
    if (!r.results.length) { box.innerHTML = '<div class="kv">没搜到这个人</div>'; return; }
    box.innerHTML = '<div class="kv" style="margin-top:10px">搜索结果（点一下直接加）：</div>'
      + r.results.slice(0, 8).map((u) => `
        <div class="item" style="margin-top:6px">
          <div class="grow"><div class="t">${esc(u.uname)}</div>
          <div class="s">mid=${esc(u.mid)} · 粉丝 ${u.fans ?? '?'}</div></div>
          <button class="sm" onclick="addMentionDirect('${esc(u.uname)}','${esc(u.mid)}')">加</button>
        </div>`).join('');
  });
}

async function addMentionDirect(uname, mid) {
  await guard(async () => {
    applyState(await api('/api/mentions', { uname, mid }));
    document.getElementById('searchResult').innerHTML = '';
    toast('✔ 已加入 @ 名单', 'ok');
  });
}

async function toggleMention(id, enabled) {
  await guard(async () => applyState(await api('/api/mentions/toggle', { id, enabled })));
}

async function deleteMention(id) {
  await guard(async () => applyState(await api('/api/mentions/delete', { id })));
}

function initPresets() {
  const sel = document.getElementById('dsPreset');
  if (!sel || sel.dataset.ready) return;
  sel.innerHTML = '<option value="">— 手动填写 / 保持不变 —</option>'
    + AI_PRESETS.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.dataset.ready = '1';
}

function applyPreset() {
  const id = document.getElementById('dsPreset').value;
  if (!id) return;
  const p = AI_PRESETS.find((x) => x.id === id);
  if (!p) return;
  document.getElementById('dsBase').value = p.baseUrl;
  document.getElementById('dsModel').value = p.model;
  document.getElementById('dsAuthMode').value = p.authMode || 'bearer';
  if (p.keyRef) document.getElementById('dsKeyRef').value = p.keyRef;
  // 预设通常不需要完整端点覆盖, 顺手清掉免得旧值把新地址顶掉
  document.getElementById('dsEndpoint').value = '';
  toast(`已填入 ${p.name} 的地址和模型，别忘了粘 Key 再点「测试连通」`);
}

function collectSettings() {
  return {
    contentPreference: document.getElementById('contentPref').value,
    stylePreference: document.getElementById('stylePref').value,
    signature: document.getElementById('signature').value,
    ds: {
      apiKey: document.getElementById('dsKey').value,
      model: document.getElementById('dsModel').value,
      baseUrl: document.getElementById('dsBase').value,
      authMode: document.getElementById('dsAuthMode').value,
      endpoint: document.getElementById('dsEndpoint').value,
      extraHeaders: document.getElementById('dsExtraHeaders').value,
      apiKeyRef: document.getElementById('dsKeyRef').value,
    },
    task: {
      videoSource: document.getElementById('videoSource').value,
      manualBvids: document.getElementById('manualBvids').value,
      videosPerRun: Number(document.getElementById('videosPerRun').value) || 1,
      delaySeconds: Number(document.getElementById('delaySeconds').value) || 12,
      searchPages: Number(document.getElementById('searchPages').value) || 1,
      dailyLimit: Number(document.getElementById('dailyLimit').value) || 10,
      dryRun: document.getElementById('dryRun').checked,
      dm: document.getElementById('dmMode').checked,
      dmForm: (document.querySelector('input[name=dmForm]:checked') || {}).value || 'card',
      dmTitle: document.getElementById('dmTitle').checked,
      dmMaxChars: clampChars(document.getElementById('dmMaxChars').value),
    },
  };
}

async function saveSettings() {
  await guard(async () => {
    applyState(await api('/api/settings', collectSettings()));
    // key 提交后立刻清空输入框, 不在页面上留残留
    document.getElementById('dsKey').value = '';
  });
}

async function testDS() {
  await guard(async () => {
    await api('/api/settings', collectSettings());
    const box = document.getElementById('dsTestOut');
    box.innerHTML = '<div class="prev">🔌 正在请求…</div>';
    const r = await api('/api/ds/test', {});
    const head = `<b>请求地址：</b><code>${esc(r.endpoint || '?')}</code><br>`
      + `<b>模型：</b>${esc(r.model || '?')} &nbsp; <b>鉴权：</b>${esc(r.authMode || '?')}`;
    if (r.ok) {
      box.innerHTML = `<div class="prev" style="border-color:#1f6b45">✔ 连通成功<br>${head}<br>`
        + `<b>模型回复：</b>${esc(r.reply)}</div>`;
      toast('✔ AI 接口通了：' + r.reply, 'ok');
    } else {
      box.innerHTML = `<div class="prev warnbox">✖ 失败<br>${head}<br>`
        + `<b>原因：</b><br>${esc(r.error || '未知')}</div>`;
      toast('✖ 连不上，看第 7 区的详情', 'err');
    }
  });
}

async function analyze() {
  await guard(async () => {
    await api('/api/settings', collectSettings());
    const box = document.getElementById('analysisOut');
    box.innerHTML = '<div class="prev">🧠 正在让 AI 分析偏好并试搜 B 站…</div>';
    const r = await api('/api/ds/analyze', {});
    const a = r.analysis;
    box.innerHTML = `
      <div class="prev">
        <b>关键词：</b>${a.keywords.map((k) => `<span class="pill on">${esc(k)}</span>`).join(' ')}<br>
        <b>内容概括：</b>${esc(a.contentSummary || '')}<br>
        <b>风格要点：</b>${esc(a.styleNotes || '')}
      </div>`
      + r.preview.map((p) => `
        <div class="prev">
          <b>搜索「${esc(p.keyword)}」</b> ${p.error ? '<span style="color:#ff6b6b">' + esc(p.error) + '</span>'
            : `命中 ${p.count} 条，前几条：`}
          ${(p.top || []).map((v) => `<div class="kv">· ${esc(v.title)} — UP ${esc(v.author)} · 播放 ${v.play}</div>`).join('')}
        </div>`).join('');
  });
}

async function preview() {
  await guard(async () => {
    await api('/api/settings', collectSettings());
    const r = await api('/api/preview', {
      text: '（这里是 DS 生成的正文）',
      dm: document.getElementById('dmMode').checked,
    });
    document.getElementById('previewOut').innerHTML = r.dm
      ? `<div class="prev"><b>私信会是这样${r.form === 'card' ? '（卡片）' : '（文字+链接）'}：</b><br>`
        + `${esc(r.message).replace(/\n/g, '<br>')}<br>`
        + `<span class="kv">${r.form === 'card'
          ? '私信模式不拼 @。这段文字会成为卡片的标题；卡片被拒会自动降级成纯文字。'
          : '私信模式不拼 @。上面是正文，末尾那行是视频链接。'}</span></div>`
      : `<div class="prev"><b>拼出来的样子：</b><br>${esc(r.message)}</div>`;
  });
}

async function runNow() {
  await guard(async () => {
    await api('/api/settings', collectSettings());
    const r = await api('/api/task/run', {
      repeat: Number(document.getElementById('videosPerRun').value) || 1,
      dryRun: document.getElementById('dryRun').checked,
      dm: document.getElementById('dmMode').checked,
    });
    toast(r.started ? (document.getElementById('dmMode').checked
      ? '▶ 私信任务已启动，看下面日志' : '▶ 任务已启动，看下面日志') : '任务没起来', 'ok');
  });
}

async function stopTask() {
  await guard(async () => { await api('/api/task/stop', {}); toast('已请求停止'); });
}

function toggleSchMode() {
  const isClock = document.getElementById('schMode').value === 'clock';
  document.getElementById('schEvery').disabled = isClock;
  document.getElementById('schDate').disabled = !isClock;
  document.getElementById('schAt').disabled = !isClock;
  document.getElementById('schDaily').disabled = !isClock;
}

async function addSchedule() {
  await guard(async () => {
    const s = await api('/api/schedules', {
      name: document.getElementById('schName').value.trim() || '未命名任务',
      mode: document.getElementById('schMode').value,
      everyMinutes: Number(document.getElementById('schEvery').value) || 60,
      clockDate: document.getElementById('schDate').value,
      clockAt: document.getElementById('schAt').value || '09:00',
      repeatDaily: document.getElementById('schDaily').checked,
      videosPerRun: Number(document.getElementById('schCount').value) || 1,
      dryRun: document.getElementById('schDry').checked,
      dm: document.getElementById('schDm').checked,
    });
    document.getElementById('schName').value = '';
    applyState(s);
    toast('✔ 自动任务已创建', 'ok');
  });
}

async function toggleSchedule(id, enabled) {
  await guard(async () => applyState(await api('/api/schedules/toggle', { id, enabled })));
}

async function deleteSchedule(id) {
  await guard(async () => applyState(await api('/api/schedules/delete', { id })));
}

/** 历史表空状态: 鲸鱼娘 + 一句话, 放在一个横跨整行的大格子里 */
function historyEmptyRow() {
  return `<tr><td colspan="7" style="padding:0">${whaleEmpty('还没有跑过任务')}</td></tr>`;
}

async function pollHistory() {
  try {
    const r = await api('/api/task/history');
    const tb = document.getElementById('histBody');
    if (!tb) return;
    if (!r.history.length) {
      tb.innerHTML = historyEmptyRow();
      return;
    }
    tb.innerHTML = r.history.map((h) => `
      <tr>
        <td>${new Date(h.startedAt).toLocaleString('zh-CN')}</td>
        <td>${esc(h.trigger)}</td>
        <td>${h.planned}</td>
        <td style="color:var(--ok)">${h.posted}</td>
        <td style="color:${h.failed ? 'var(--err)' : 'var(--dim)'}">${h.failed}</td>
        <td>${h.skipped}</td>
        <td>${h.ms ? (h.ms / 1000).toFixed(1) + 's' : '-'}</td>
      </tr>`).join('');
  } catch { /* ignore */ }
}

async function clearHistoryConfirm() {
  if (!confirm('清空任务历史？\ndata/history.jsonl 会被删掉，删了就找不回来了。')) return;
  try {
    await api('/api/task/history/clear', {});
    const tb = document.getElementById('histBody');
    if (tb) tb.innerHTML = historyEmptyRow();
    toast('任务历史已清空', 'ok');
  } catch (e) {
    toast('清空失败: ' + e.message, 'err');
  }
}

async function loadSkins() {
  try {
    const r = await api('/api/skins');
    const box = document.getElementById('skinSwatches');
    const all = r.presets.map((p) => ({ ...p, preview: PRESET_GRADIENTS[p.id] }))
      .concat(r.custom.map((c) => ({ ...c, preview: `url(${c.url}) center/cover` })));
    box.innerHTML = all.map((s) => `
      <div class="swatch ${s.id === r.active ? 'sel' : ''}" onclick="activateSkin('${esc(s.id)}')"
           title="${esc(s.name)}${s.type === 'custom' ? '（自定义）' : ''}">
        <div class="preview" style="background:${esc(s.preview)}"></div>
        <div class="lbl">${esc(s.name)}${s.type === 'custom' ? ' 🖼' : ''}</div>
      </div>`).join('') || '<span class="kv">加载失败</span>';
    applySkin(r.active, r.custom);
  } catch (e) { toast('皮肤加载失败: ' + e.message, 'err'); }
}

function applySkin(active, customList) {
  document.body.classList.remove('skin-custom');
  document.body.style.background = '';
  document.body.style.backgroundImage = '';
  if (active && active.startsWith('custom:')) {
    const c = (customList || []).find((x) => x.id === active);
    if (c) {
      document.body.classList.add('skin-custom');
      document.body.style.backgroundImage = 'linear-gradient(var(--skin-veil,rgba(4,12,20,.82)),var(--skin-veil,rgba(4,12,20,.9))),'
        + `url(${c.url})`;
      document.body.style.backgroundSize = 'cover';
      document.body.style.backgroundAttachment = 'fixed';
      return;
    }
  }
  // 皮肤只换背景: 文字色/提示色在主题里配, 这里保留原样
  const bg = PRESET_GRADIENTS[active] || PRESET_GRADIENTS.default;
  document.body.style.background = bg;
  document.body.style.backgroundAttachment = 'fixed';
}

async function activateSkin(id) {
  await guard(async () => {
    await api('/api/skin/activate', { id });
    toast('✔ 皮肤已切换', 'ok');
    await loadSkins();
  });
}

async function uploadSkin() {
  await guard(async () => {
    const file = document.getElementById('skinFile').files[0];
    if (!file) throw new Error('先选一张 PNG');
    if (file.size > 8 * 1024 * 1024) throw new Error('图片超过 8MB');
    const data = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(file);
    });
    await api('/api/skin/upload', { data });
    toast('✔ 皮肤已导入并启用', 'ok');
    document.getElementById('skinFile').value = '';
    await loadSkins();
  });
}

/* 关掉后端服务。打包成 exe 后没有控制台窗口可关, 所以网页得自己提供出口。 */
async function shutdownConsole() {
  if (!confirm('确定关闭控制台？\n\n关掉之后这个页面就不能操作了，需要重新双击 bili-studio.exe 才能再用。')) return;
  try { await api('/api/shutdown', {}); } catch { /* 进程退出时连接被重置, 属正常 */ }
  clearInterval(pollTimer);
  pollTimer = null;
  document.body.innerHTML = `
    <div style="max-width:640px;margin:12vh auto;padding:36px;text-align:center;
                background:#0e2b3d;border:1px solid #1d4a63;border-radius:16px">
      <div style="font-size:46px">🐋</div>
      <h2 style="margin:12px 0 6px">控制台已关闭</h2>
      <p style="color:#7ba7bf;font-size:13px;margin:0">
        后端服务已经停止，这个页面可以关掉了。<br>
        想再用的话，重新双击 <b>bili-studio.exe</b> 就行。
      </p>
    </div>`;
}

async function boot() {
  initWins();
  initThemes();
  initTerm();
  toggleSchMode();
  initPresets();
  initMiniDrag();
  restoreMiniGeom();
  applyState(await api('/api/state'));
  await loadSkins();
  await pollLogs();
  await pollHistory();
  watchLogVisibility();
  clearInterval(pollTimer);
  pollTimer = setInterval(pollLogs, 1500);
  setInterval(pollHistory, 5000);
  setInterval(async () => {
    try { applyState(await api('/api/state')); } catch { /* ignore */ }
  }, 8000);
  // v1.6.0: 打开页面先静默验一遍活, 过期的号会在账户卡片上亮红灯
  setTimeout(() => { checkAllAccounts(false); }, 1200);
}

/* 启动 */
// 注意: 这个脚本可能在 DOMContentLoaded 之前就被执行(script 在 body 末尾或提前注入),
// 那样 #workspace 里的 .card 还没解析完, initWins 会一个窗口都建不出来。
// 以前所有函数都在同一个文件里时靠执行顺序侥幸躲过去了, 拆成片段后必须显式等待 DOM。
window.__jsErrors = window.__jsErrors || [];
window.addEventListener('error', (e) => {
  window.__jsErrors.push(String(e.message || e.error || 'unknown'));
});
function bootWhenReady() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootWhenReady, { once: true });
    return;
  }
  boot().catch((e) => {
    window.__jsErrors.push('boot: ' + e.message);
    toast('启动失败: ' + e.message + '（服务起来了吗？）', 'err');
  });
}
bootWhenReady();
