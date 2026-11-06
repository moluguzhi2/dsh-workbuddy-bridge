/** 本地自测：不经过 cordis，直接起桥并打真实请求。运行：node test/smoke.mjs */

import { startServer } from '../lib/index.js';

const PORT = Number(process.env.WB_BRIDGE_PORT || 19427);
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const record = (n, ok, detail) => {
  results.push({ n, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${detail ? '  ' + detail : ''}`);
};

const server = startServer();
await new Promise((r) => (server.listening ? r() : server.once('listening', r)));

try {
  let r = await fetch(`${BASE}/healthz`);
  let b = await r.json();
  record('healthz', r.ok && b.ok === true, JSON.stringify(b));

  r = await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer anything' } });
  b = await r.json();
  record('GET /v1/models', r.ok && Array.isArray(b.data) && b.data.length > 0, `${b.data?.length} models`);

  r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
    body: JSON.stringify({
      model: 'auto',
      stream: false,
      messages: [
        { role: 'system', content: 'You are an AI agent powered by DeepSeek Harness. You help with software engineering.' },
        { role: 'user', content: 'reply with the single word: pong' },
      ],
    }),
  });
  b = await r.json();
  record('chat non-stream (带 11128 指纹 system)', r.ok && b.choices?.[0]?.message?.content?.length > 0,
    `status=${r.status} text=${JSON.stringify(String(b.choices?.[0]?.message?.content || '').slice(0, 40))}`);

  r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'say hi' }],
    }),
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let events = 0;
  for (let i = 0; i < 5; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    events += (buf.match(/^data: /gm) || []).length;
    buf = buf.replace(/^data: .*$/gm, '');
    if (events >= 2) break;
  }
  await reader.cancel().catch(() => {});
  record('chat SSE', r.ok && events > 0, `data-events>=${events}`);
} finally {
  await new Promise((r) => server.close(r));
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
