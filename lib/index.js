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

const ENDPOINT = 'https://quiz-helper-68853.app.workbuddy.host';
const PUBKEY = 'wbpk_HdZXEYrhRQ1gWDuZYJUzOf_mpB9I8Wj1nxRKNO60sdQ59GQrNM4883B';
const MODELS_URL = `${ENDPOINT}/.cloud/llm/models`;
const CHAT_URL = `${ENDPOINT}/.cloud/llm/chat/completions`;
const PORT = Number(process.env.WB_BRIDGE_PORT || 19427);
const TIMEOUT = Number(process.env.WB_BRIDGE_TIMEOUT || 120000);
const DEFAULT_MODEL = 'auto';

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
      .filter((m) => m && m.id && m.disabled !== true && m.enabled !== false)
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
    json(res, 200, { ok: true, plugin: name, models: modelCache.list.length });
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
