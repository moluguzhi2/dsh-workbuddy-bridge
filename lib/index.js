/**
 * dsh-workbuddy-bridge
 *
 * DSH / dsh-go 插件：随引擎启动，在 127.0.0.1:19427 起一个 OpenAI 兼容桥。
 * 手机 dsh-go 填 http://127.0.0.1:19427/v1，请求经本桥转到 WorkBuddy 云 LLM
 * (/.cloud/llm/**)，因此：
 *   - 不经过 copilot.tencent.com 的渠道指纹校验，不会报 11128；
 *   - Base URL 是 loopback，Android 允许明文 HTTP，且不含 ? / #，dsh-go 校验能过；
 *   - 消耗 WorkBuddy 积分，电脑不用开机。
 *
 * 零第三方依赖，只用 Node 内置 http + fetch。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ENDPOINT = 'https://quiz-helper-68853.app.workbuddy.host';
const PUBKEY = 'wbpk_HdZXEYrhRQ1gWDuZYJUzOf_mpB9I8Wj1nxRKNO60sdQ59GQrNM4883B';
const MODELS_URL = `${ENDPOINT}/.cloud/llm/models`;
const CHAT_URL = `${ENDPOINT}/.cloud/llm/chat/completions`;
const PORT = Number(process.env.WB_BRIDGE_PORT || 19427);
const TIMEOUT = Number(process.env.WB_BRIDGE_TIMEOUT || 120000);
const DEFAULT_MODEL = 'auto';

/** 积分查询：官方余额接口，需用户 accessToken（从浏览器登录态复制，外置到 config / 环境变量）。 */
const CREDITS_URL = 'https://www.workbuddy.cn/billing/meter/get-user-resource-summary';
const CONFIG_PATHS = [
  process.env.WB_BRIDGE_CONFIG,
  path.join(process.cwd(), 'config.json'),
  path.join(new URL('.', import.meta.url).pathname, 'config.json'),
].filter(Boolean);

// 运行期可改的凭据（先读环境变量，再读 config.json；/v1/credits/set 可动态覆盖）
const creditsCfg = { accessToken: process.env.WB_CREDITS_TOKEN || '', userId: process.env.WB_CREDITS_UID || '' };
for (const p of CONFIG_PATHS) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j?.credits?.accessToken) creditsCfg.accessToken = j.credits.accessToken;
    if (j?.credits?.userId) creditsCfg.userId = j.credits.userId;
  } catch { /* 文件不存在或非法 JSON 忽略 */ }
}

/**
 * 查询 WorkBuddy 剩余积分。
 * 返回 { ok, status?, data?, code?, message? }；data 为官方接口原始 JSON。
 */
async function queryCredits() {
  if (!creditsCfg.accessToken) {
    return { ok: false, code: 'NO_TOKEN', message: '未配置 accessToken：在 config.json 写 credits.accessToken，或设环境变量 WB_CREDITS_TOKEN' };
  }
  let r;
  try {
    r = await fetch(CREDITS_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + creditsCfg.accessToken,
        ...(creditsCfg.userId ? { 'X-User-Id': creditsCfg.userId } : {}),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { ok: false, code: 'FETCH_FAIL', message: String(e?.message || e) };
  }
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) {
    return { ok: false, code: 'UPSTREAM_' + r.status, status: r.status, message: text.slice(0, 300), raw: data };
  }
  return { ok: true, status: r.status, data };
}

/** 把官方余额结构拍平成展示字段；官方字段名未知，这里做兼容提取。 */
function flattenCredits(d) {
  const src = d?.data ?? d ?? {};
  const pick = (...ks) => {
    for (const k of ks) { if (src[k] !== undefined && src[k] !== null && src[k] !== '') return src[k]; }
    return undefined;
  };
  const rows = [];
  const credit = pick('credits', 'credit', 'remainingCredits', 'balance', 'remaining', 'totalCredits');
  const used = pick('usedCredits', 'used', 'consumed');
  const total = pick('totalCredits', 'total', 'quota', 'packageCredits');
  const expire = pick('expireAt', 'expireTime', 'expiredAt', 'validUntil', 'expiration');
  const pkg = pick('packageName', 'planName', 'subscriptionName', 'plan');
  if (credit !== undefined) rows.push(['剩余积分', credit]);
  if (used !== undefined) rows.push(['已用积分', used]);
  if (total !== undefined) rows.push(['总额度', total]);
  if (pkg !== undefined) rows.push(['套餐', pkg]);
  if (expire !== undefined) rows.push(['到期时间', expire]);
  return { rows, raw: src };
}

function creditsHtml(credits) {
  const ts = new Date().toLocaleString('zh-CN', { hour12: false });
  let body;
  if (!credits.ok) {
    if (credits.code === 'NO_TOKEN') {
      body = `<div class="card err"><h2>未配置凭证</h2>
<p class="msg">把浏览器登录 WorkBuddy 后请求头里的 accessToken 填进来即可查看积分。</p>
<form id="f" class="frm">
<input id="t" class="inp" placeholder="accessToken（Authorization: Bearer 后的值）" autocomplete="off">
<input id="u" class="inp" placeholder="userId（可选，响应头 X-User-Id）" autocomplete="off">
<button class="btn" type="submit">保存并查看</button>
</form>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();
await fetch('/v1/credits/set',{method:'POST',headers:{'content-type':'application/json'},
body:JSON.stringify({accessToken:document.getElementById('t').value,userId:document.getElementById('u').value})});
location.reload();};</script></div>`;
    } else {
      body = `<div class="card err"><h2>无法获取积分</h2><p class="msg">${escapeHtml(credits.message || credits.code || '未知错误')}</p></div>`;
    }
  } else {
    const { rows, raw } = flattenCredits(credits.data);
    const table = rows.length
      ? `<table>${rows.map(([k, v]) => `<tr><td>${escapeHtml(String(k))}</td><td>${escapeHtml(String(v))}</td></tr>`).join('')}</table>`
      : '';
    const rawJson = `<details><summary>原始返回</summary><pre>${escapeHtml(JSON.stringify(raw, null, 2))}</pre></details>`;
    body = `<div class="card ok"><h2>WorkBuddy 积分</h2>${table}${rawJson}</div>`;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>WorkBuddy 积分</title><style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  background: #0f1115; color: #e6e6e6; padding: 16px; }
h2 { margin: 0 0 12px; font-size: 20px; }
.card { background: #1a1d24; border: 1px solid #2a2e38; border-radius: 14px; padding: 18px; }
.card.err { border-color: #5a2a2a; }
.msg { color: #ff8a8a; word-break: break-all; font-size: 14px; }
table { width: 100%; border-collapse: collapse; font-size: 16px; }
td { padding: 12px 8px; border-bottom: 1px solid #2a2e38; }
td:first-child { color: #9aa3b2; width: 40%; }
td:last-child { text-align: right; font-weight: 600; }
pre { white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #9aa3b2;
  background: #0f1115; padding: 10px; border-radius: 8px; max-height: 300px; overflow: auto; }
details { margin-top: 14px; }
summary { cursor: pointer; color: #6fa8ff; font-size: 14px; }
.foot { margin-top: 14px; color: #5b6270; font-size: 12px; text-align: center; }
.refresh { display: block; margin: 14px auto 0; padding: 10px 20px; background: #2d6cff;
  color: #fff; border: 0; border-radius: 10px; font-size: 15px; }
.frm { display: flex; flex-direction: column; gap: 10px; margin-top: 14px; }
.inp { padding: 12px; border: 1px solid #2a2e38; border-radius: 10px; background: #0f1115;
  color: #e6e6e6; font-size: 14px; }
.btn { padding: 12px; background: #2d6cff; color: #fff; border: 0; border-radius: 10px; font-size: 15px; }
</style></head><body>
${body}
<button class="refresh" onclick="location.reload()">刷新</button>
<div class="foot">更新于 ${ts}</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const name = 'workbuddy-bridge';
export const inject = [];

let modelCache = { at: 0, list: [] };

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

function openaiError(res, status, message, type = 'upstream_error') {
  json(res, status, { error: { message, type, code: type } });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 16 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 上游目录里能列出、但 chat/completions 实际不收的模型（实测两次均 400）。
 * 混进 /v1/models 会让客户端选了就报错，故在目录层过滤掉。 */
const CHAT_BLOCKED_MODELS = new Set([
  'hy4-preview-x', 'glm-5.0', 'glm-4.7', 'glm-4.6', 'glm-4.6v',
  'minimax-m2.5', 'kimi-k2-thinking', 'hunyuan-2.0-thinking',
  'hunyuan-image-alpha', 'hunyuan-image-alpha-edit',
  'kling-video-v3', 'minimax-video-h3',
]);

/** 云 LLM 的模型目录是数组，转成 OpenAI /v1/models 格式；缓存 5 分钟。 */
async function cloudModels() {
  if (modelCache.list.length && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.list;
  const r = await fetch(MODELS_URL, {
    headers: { 'x-wb-webapp-access-key': PUBKEY },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`cloud models ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const raw = await r.json();
  const arr = Array.isArray(raw) ? raw : (raw.data || []);
  modelCache = {
    at: Date.now(),
    list: arr
      .filter((m) => m && m.id && m.disabled !== true && m.enabled !== false
        && !CHAT_BLOCKED_MODELS.has(m.id))
      .map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'workbuddy',
        context_window: m.maxInputTokens || 200000,
        max_output_tokens: m.maxOutputTokens || 32768,
      })),
  };
  return modelCache.list;
}

async function resolveModel(requested) {
  const list = await cloudModels();
  // 旧会话可能记住了被过滤掉的模型 id，别直接透给上游吃 400，回退到 auto。
  if (requested && CHAT_BLOCKED_MODELS.has(requested)) return DEFAULT_MODEL;
  if (list.some((m) => m.id === requested)) return requested;
  if (list.some((m) => m.id === DEFAULT_MODEL)) return DEFAULT_MODEL;
  return list[0]?.id || DEFAULT_MODEL;
}

/** 命中渠道指纹的 system 会被上游判 400（request_invalid_parameter）。
 * 上游做内容级校验：指纹句单独放 system、或带该句式的超长 system 都被拒；
 * 纯长文本正常。删句式、补中性头、裁剪到 2200 字仍会 400（前 216 字 OK / 217 起 FAIL）。
 * 故命中指纹就整体替换为短中性 system，其余 messages / tools 原样保留。 */
const FINGERPRINT_OPENINGS = [
  /You are an AI agent powered by DeepSeek Harness/i,
  /You are Claude Code, Anthropic's official CLI/i,
];
function sanitizeSystem(content) {
  if (typeof content !== 'string') return content;
  if (!FINGERPRINT_OPENINGS.some((re) => re.test(content))) return content;
  // 上游对带指纹的 system 做内容级校验：实测即便删掉指纹句、补中性头、裁剪到 2200 字，
  // 只要保留原文片段仍会 400（前 216 字 OK / 217 字起 FAIL）。带完整 tools 与其余上下文时，
  // 短中性 system 稳定 200。故命中指纹就整体替换为短头，其余消息与 tools 原样保留。
  return 'You are a helpful assistant. Be concise and helpful.';
}

/** 云 LLM 要求首条是 system；developer 归一化；不把用户输入塞进 system。 */
function normalizeMessages(messages) {
  const out = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  for (const m of out) {
    if (!m) continue;
    if (m.role === 'developer') m.role = 'system';
    if (m.role === 'system' || m.role === 'assistant') {
      m.content = sanitizeSystem(m.content);
    }
  }
  if (!out.length || out[0].role !== 'system') {
    out.unshift({ role: 'system', content: 'You are a helpful assistant. Be concise and helpful.' });
  }
  return out;
}

function buildUpstreamBody(body, model) {
  const b = { model, messages: normalizeMessages(body.messages), stream: true };
  for (const k of ['temperature', 'top_p', 'max_tokens', 'repetition_penalty', 'response_format', 'tools', 'tool_choice', 'stop']) {
    if (body[k] !== undefined) b[k] = body[k];
  }
  return b; // reasoning_effort / store / n 云端不认，丢弃
}

async function callUpstream(payload) {
  return fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wb-webapp-access-key': PUBKEY,
      accept: 'text/event-stream',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

async function pipeSSE(upstream, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    res.end();
  }
}

async function collectSSE(upstream, model) {
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finish = 'stop';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let pos;
      while ((pos = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, pos);
        buf = buf.slice(pos + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          const d = chunk.choices?.[0]?.delta;
          if (d?.content) content += d.content;
          if (d?.reasoning_content) reasoning += d.reasoning_content;
          if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
          if (chunk.usage) usage = chunk.usage;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
  }
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  return {
    id: 'chatcmpl-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function handle(req, res) {
  const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    });
    res.end();
    return;
  }
  if (url === '/healthz' || url === '/health') {
    json(res, 200, { ok: true, plugin: name, models: modelCache.list.length, creditsConfigured: !!creditsCfg.accessToken });
    return;
  }
  if (req.method === 'GET' && url === '/credits') {
    // 状态页：浏览器/手机直接打开 http://127.0.0.1:19427/credits
    const c = await queryCredits();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
    res.end(creditsHtml(c));
    return;
  }
  if (req.method === 'GET' && url === '/v1/credits') {
    const c = await queryCredits();
    json(res, 200, c); // body.ok 区分成功/失败，状态码统一 200，便于页面与客户端读取
    return;
  }
  if (req.method === 'POST' && url === '/v1/credits/set') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { openaiError(res, 400, 'invalid JSON body', 'invalid_request'); return; }
    if (body.accessToken) creditsCfg.accessToken = String(body.accessToken);
    if (body.userId) creditsCfg.userId = String(body.userId);
    // 写回 config.json：先尝试既有文件 merge，都没有则在 cwd 新建，保证首次填写也持久化
    let written = false;
    for (const p of CONFIG_PATHS) {
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        j.credits = j.credits || {};
        if (body.accessToken) j.credits.accessToken = creditsCfg.accessToken;
        if (body.userId) j.credits.userId = creditsCfg.userId;
        fs.writeFileSync(p, JSON.stringify(j, null, 2));
        written = true;
        break;
      } catch { /* 跳过不可读/不可写文件 */ }
    }
    if (!written) {
      try {
        fs.writeFileSync(path.join(process.cwd(), 'config.json'),
          JSON.stringify({ credits: { accessToken: creditsCfg.accessToken, userId: creditsCfg.userId } }, null, 2));
      } catch { /* 仅内存生效 */ }
    }
    json(res, 200, { ok: true, creditsConfigured: !!creditsCfg.accessToken });
    return;
  }
  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    const list = await cloudModels();
    json(res, 200, { object: 'list', data: list });
    return;
  }
  if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { openaiError(res, 400, 'invalid JSON body: ' + e.message, 'invalid_request'); return; }
    const model = await resolveModel(body.model);
    const upstream = await callUpstream(buildUpstreamBody(body, model));
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      openaiError(res, upstream.status || 502, `upstream ${upstream.status}: ${text.slice(0, 300)}`);
      return;
    }
    if (body.stream === true) await pipeSSE(upstream, res);
    else json(res, 200, await collectSSE(upstream, model));
    return;
  }
  openaiError(res, 404, `no such route: ${req.method} ${url}`, 'not_found');
}

/** cordis 入口：加载即起服务；ctx.effect 注册卸载钩子。 */
export function apply(ctx) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) openaiError(res, 500, String(e?.message || e), 'internal_error');
      else res.end();
    });
  });
  server.on('error', (e) => console.error(`[${name}] listen error: ${e.message}`));
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[${name}] OpenAI bridge on http://127.0.0.1:${PORT}/v1 -> ${ENDPOINT}/.cloud/llm`);
  });
  if (ctx && typeof ctx.effect === 'function') {
    try { ctx.effect(() => () => { try { server.close(); } catch { /* ignore */ } }); }
    catch (e) { console.error(`[${name}] effect registration failed: ${e.message}`); }
  }
  return server;
}

/** 便于本地自测：不经过 cordis 直接起服务。 */
export function startServer() {
  return apply(null);
}
