#!/usr/bin/env node
/**
 * dsh-workbuddy-bridge 故障注入 / 自愈回归测试（零第三方依赖）。
 *
 * 把历史上出现过的每一种「又坏了」都真实注入一次，等守护自愈后断言恢复：
 *   代码被覆盖、渠道配置被改坏、积分配置丢失、引擎被杀、上游连续请求、
 *   守护单实例、开机自启、电池白名单。
 *
 * 用法（电脑端，手机 USB 调试已开）：
 *   node test/chaos.mjs
 *   node test/chaos.mjs --port 5048 --wait 18 --out chaos-report.json
 *   node test/chaos.mjs --skip-relaunch     # 不想打断手机上的会话时跳过杀引擎
 *
 * 参数：
 *   --port           adb server 端口，默认 5048（避开 5037 冲突）
 *   --wait           每次注入后等守护自愈的秒数，默认 18（守护周期 15s）
 *   --skip-relaunch  跳过「am force-stop 引擎」这项打断性测试
 *   --out            额外把结果写成 JSON 文件
 *
 * 失败不自动修现场：脚本末尾会打印最终状态，按 README 的升级顺序可恢复。
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = arg('--port', '5048');
const WAIT = Number(arg('--wait', '18'));
const OUT = arg('--out', '');
const SKIP_RELAUNCH = argv.includes('--skip-relaunch');
const LOCAL_ONLY = argv.includes('--local-only');
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const BASE = '/data/adb/dsh-wb-bridge';
const RF = '/data/user/0/io.github.ccch1mneyyy.dsh_app/files/runtime/rootfs';
const DST = `${RF}/root/.dsh/profiles/web/node_modules/dsh-workbuddy-bridge/lib/index.js`;
const DST_PATCH = `${RF}/root/.dsh/profiles/web/cordis.patch.yml`;
const DCFG = `${RF}/root/.dsh/bridge-config.json`;
const GOLD_CODE = `${BASE}/bridge.mjs`;
const GOLD_PATCH = `${BASE}/cordis.patch.yml.golden`;
const PKG = 'io.github.ccch1mneyyy.dsh_app';
const BRIDGE = 'http://127.0.0.1:19427';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
}
function skip(name, why) {
  results.push({ name, ok: null, detail: why });
  console.log(`SKIP  ${name}  · ${why}`);
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

// Windows 上 adb daemon 偶发挂掉（socket 权限冲突），表现为命令失败 + forward 全丢。
// 只在同一次调用里重启 daemon 并重试一次：实测「taskkill + 换端口」的级联处理
// 反而会不停杀掉刚起来的 daemon，把后半段测试全拖崩，所以不做硬杀与端口切换。
const CUR_PORT = PORT;
const rawAdb = (args, timeout) => spawnSync('adb', ['-P', String(CUR_PORT), ...args], { encoding: 'utf8', timeout });
const isBadAdb = (r) => (r.error && /ENOENT|ETIMEDOUT/.test(String(r.error)))
  || /cannot connect to daemon|no devices\/emulators|failed to start daemon|failed to check server/.test((r.stdout || '') + (r.stderr || ''));

function adb(args, timeout = 20000) {
  let r = rawAdb(args, timeout);
  if (isBadAdb(r)) {
    spawnSync('adb', ['-P', String(CUR_PORT), 'start-server'], { encoding: 'utf8', timeout: 12000 });
    // 同步等 daemon 就绪（adb() 是同步函数，不能用异步 sleep）
    spawnSync('adb', ['-P', String(CUR_PORT), 'devices'], { encoding: 'utf8', timeout: 10000 });
    r = rawAdb(args, timeout);
  }
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const sh = (cmd) => adb(['shell', cmd]).out;
const sha = (p) => (sh(`sha256sum ${p}`).split(/\s+/)[0] || '');
function curl(args, timeout = 15) {
  const r = spawnSync('curl', ['--noproxy', '*', '-s', '--max-time', String(timeout), ...args],
    { encoding: 'utf8', timeout: (timeout + 5) * 1000, cwd: REPO_ROOT });
  return { out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}
// adb daemon 在 Windows 上会中途重启，重启后既有 forward 全丢，curl 会返回 000。
// 遇到 000 就重建 forward 再试一次，避免把「电脑端 adb 抖动」误判成「手机端桥坏了」。
const httpCode = (path, timeout = 10) => {
  const args = ['-o', '/dev/null', '-w', '%{http_code}', BRIDGE + path];
  let c = curl(args, timeout).out;
  if (!/^\d{3}$/.test(c) || c === '000') { forward(); c = curl(args, timeout).out; }
  return c;
};
const getJson = (path, timeout = 10) => {
  let j = null;
  try { j = JSON.parse(curl([BRIDGE + path], timeout).out); } catch { /* ignore */ }
  if (!j) { forward(); try { j = JSON.parse(curl([BRIDGE + path], timeout).out); } catch { /* ignore */ } }
  return j;
};

async function waitHealth(maxSec, label) {
  const t0 = Date.now();
  let code = '000';
  while ((Date.now() - t0) / 1000 < maxSec) {
    code = httpCode('/healthz', 6);
    if (code === '200') return true;
    await sleep(3);
  }
  console.log(`      ${label}: 等待 ${maxSec}s 后 healthz=${code}`);
  return false;
}
function forward() {
  adb(['forward', '--remove-all']);
  adb(['forward', 'tcp:19427', 'tcp:19427']);
}

/**
 * 本地上游故障模拟：在电脑上起假上游 + 本地桥，验证 WAF 403 自愈。
 * 不碰手机上的任何配置；两个端口都用 listen(0) 动态分配，避开本机已占用端口
 * （实测 19428 被另一个 node 服务占着，写死端口会让本地桥进热备、测试全 000）。
 */
async function localFaultTests() {
  console.log('--- 本地上游故障模拟（WAF 403）---');
  let n = 0;
  let mode = 'transient';
  const fake = http.createServer((req, res) => {
    if (req.url.startsWith('/.cloud/llm/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 'auto', maxInputTokens: 200000 }]));
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      n++;
      let body = {};
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      const syslen = String(body.messages?.[0]?.content || '').length;
      const block = mode === 'transient' ? n <= 2 : (!!body.tools || syslen > 200);
      if (block) {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><head><title>WAF拦截页面</title></head><body>blocked</body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  let bridge = null;
  try {
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    const fakePort = fake.address().port;
    // 再取一个空闲端口给本地桥，避免与其它服务撞车
    const probe = http.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const bridgePort = probe.address().port;
    await new Promise((r) => probe.close(() => r()));

    const env = { ...process.env };
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) delete env[k];
    env.WB_BRIDGE_PORT = String(bridgePort);
    env.WB_BRIDGE_ENDPOINT = `http://127.0.0.1:${fakePort}`;
    env.WB_BRIDGE_ATTEMPTS = '3';
    env.WB_BRIDGE_RETRY_MS = '100';
    bridge = spawn(process.execPath, ['--input-type=module', '-e',
      "import { startServer } from './lib/index.js'; startServer(); setInterval(()=>{}, 1000);"],
      { cwd: REPO_ROOT, env, stdio: 'ignore' });

    // 等本地桥真正监听再打，别用固定 sleep 赌启动速度
    const localBase = `http://127.0.0.1:${bridgePort}`;
    let up = false;
    for (let i = 0; i < 20; i++) {
      up = curl(['-o', '/dev/null', '-w', '%{http_code}', localBase + '/healthz'], 5).out === '200';
      if (up) break;
      await sleep(1);
    }
    check('本地桥启动成功', up, `port=${bridgePort} upstream=${fakePort}`);

    // 用 Node 内置 fetch 发 POST：这台 Windows 上 curl 的 POST 会返 000 且无 stderr
    // （GET 正常），属于本机 curl/代理环境问题，与桥无关。undici 连 loopback 稳定。
    const post = async (payload) => {
      try {
        const r = await fetch(localBase + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(25000),
        });
        const j = await r.json().catch(() => null);
        return { code: String(r.status), reply: j?.choices?.[0]?.message?.content || '', err: '' };
      } catch (e) {
        return { code: '000', reply: '', err: String(e?.cause?.code || e?.message || e) };
      }
    };

    // 场景 1：瞬时 WAF 403（前两次被拦）→ 桥内重试放行
    mode = 'transient'; n = 0;
    const r1 = await post({ model: 'auto', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    const d1 = (() => { try { return JSON.parse(curl([localBase + '/v1/diag'], 10).out); } catch { return null; } })();
    check('瞬时 WAF 403 自动重试成功', r1.code === '200' && r1.reply === 'OK' && (d1?.stats?.retries || 0) >= 2,
      `http=${r1.code} retries=${d1?.stats?.retries}${r1.err ? ' curl=' + r1.err.slice(0, 80) : ''}`);

    // 场景 2：按内容持续 403（带 tools / 长 system）→ 逐级降级放行
    mode = 'content'; n = 0;
    const tools = Array.from({ length: 2 }, (_, i) => ({ type: 'function', function: { name: 't' + i, parameters: { type: 'object' } } }));
    const r2 = await post({ model: 'auto', stream: false, tools,
      messages: [{ role: 'system', content: 'x'.repeat(250) }, { role: 'user', content: 'hi' }] });
    const d2 = (() => { try { return JSON.parse(curl([localBase + '/v1/diag'], 10).out); } catch { return null; } })();
    check('持续 WAF 403 自动降级成功', r2.code === '200' && r2.reply === 'OK' && (d2?.stats?.fallbacks || 0) >= 1,
      `http=${r2.code} fallbacks=${d2?.stats?.fallbacks}${r2.err ? ' curl=' + r2.err.slice(0, 80) : ''}`);
  } catch (e) {
    check('本地上游故障模拟可运行', false, String(e?.message || e));
  } finally {
    if (bridge) { try { bridge.kill(); } catch { /* ignore */ } }
    await new Promise((r) => { try { fake.close(() => r()); } catch { r(); } });
  }
}

async function main() {
  console.log('=== dsh-workbuddy-bridge 故障注入 / 自愈回归测试 ===');
  console.log(`adb -P ${PORT} · 自愈等待 ${WAIT}s · 引擎重启测试 ${SKIP_RELAUNCH ? '跳过' : '执行'}`);

  // 本地故障模拟放最前面：完全不碰 adb，不受后面 daemon 抖动影响
  await localFaultTests();
  if (LOCAL_ONLY) {
    const p = results.filter((r) => r.ok === true).length;
    const f = results.filter((r) => r.ok === false).length;
    console.log(`\n=== SUMMARY (local only) === total=${results.length} pass=${p} fail=${f}`);
    process.exit(f ? 1 : 0);
  }

  adb(['start-server']);
  await sleep(2);
  const dev = adb(['devices']).out;
  check('设备在线', /\bdevice\b/.test(dev.split('\n').slice(1).join('\n')), dev.split('\n').slice(1).join(' ').trim());
  forward();

  // --- 只读基线 ---
  const h0 = httpCode('/healthz');
  check('基线 healthz 200', h0 === '200', `http=${h0}`);
  const diag0 = getJson('/v1/diag');
  check('自愈参数就位', !!diag0 && diag0.attempts >= 4 && diag0.sys_max_keep === 2000,
    diag0 ? `attempts=${diag0.attempts} sysMax=${diag0.sys_max_keep} pid=${diag0.pid}` : 'diag 不可达');
  check('诊断字段含 lastWaf', !!diag0 && Object.prototype.hasOwnProperty.call(diag0.stats || {}, 'lastWaf'));

  const daemonCount = Number(sh("ps -A -o ARGS 2>/dev/null | grep -c '[d]aemon.sh'") || '0');
  check('守护单实例运行', daemonCount === 1, `count=${daemonCount}`);
  const boot = sh('cat /data/adb/service.d/dsh-wb-bridge.sh');
  check('开机自启入口', boot.includes('BASE=/data/adb/dsh-wb-bridge') && boot.includes('setsid'), `${boot.split('\n').length} 行`);
  check('守护脚本语法', sh(`sh -n ${BASE}/daemon.sh && echo OK`).includes('OK'));
  check('电池优化白名单', sh("dumpsys deviceidle whitelist 2>/dev/null | grep -c 'io.github.ccch1mneyyy.dsh_app'") === '1');

  const codeGold = sha(GOLD_CODE);
  const patchGold = sha(GOLD_PATCH);
  check('代码 golden 一致', codeGold.length === 64 && sha(DST) === codeGold, codeGold.slice(0, 12));
  check('配置 golden 一致', patchGold.length === 64 && sha(DST_PATCH) === patchGold, patchGold.slice(0, 12));

  // --- 组合故障注入：三个东西同时坏，等一轮守护全部还原 ---
  console.log('--- 注入组合故障（代码 / 配置 / 积分凭证）---');
  sh(`echo '# chaos-tamper' >> ${DST}`);
  sh(`echo '# chaos-tamper' >> ${DST_PATCH}`);
  const creditsConfigured = !!(diag0 && diag0.creditsConfigured);
  let dcfgTouched = false;
  if (!creditsConfigured) { sh(`rm -f ${DCFG}`); dcfgTouched = true; }
  else skip('积分配置删除重建', '已配置 accessToken，避免破坏真实凭证');

  const codeTampered = sha(DST) !== codeGold;
  const patchTampered = sha(DST_PATCH) !== patchGold;
  check('故障确实注入成功', codeTampered && patchTampered, `code=${codeTampered} patch=${patchTampered}`);
  await sleep(WAIT);
  forward(); // 长等待期间 adb daemon 可能已被系统重启，先站稳连接再取证据
  check('篡改代码自动还原', codeTampered && sha(DST) === codeGold, sha(DST).slice(0, 12));
  check('篡改渠道配置自动还原', patchTampered && sha(DST_PATCH) === patchGold, sha(DST_PATCH).slice(0, 12));
  if (dcfgTouched) {
    const rebuilt = sh(`test -f ${DCFG} && echo YES`);
    check('积分配置自动重建', rebuilt.includes('YES'), sh(`cat ${DCFG}`).slice(0, 60));
  }
  // 还原 cordis.patch.yml 可能触发引擎热重载，允许短暂抖动，但必须自动恢复
  const healthAfter = await waitHealth(25, '组合故障自愈后');
  check('自愈后 healthz 自动恢复 200', healthAfter, healthAfter ? 'healthz=200' : '25s 内未恢复');

  // --- 守护单实例：重复执行自启入口不应起第二个 ---
  sh('sh /data/adb/dsh-wb-bridge/service.sh');
  await sleep(3);
  const d2 = Number(sh("ps -A -o ARGS 2>/dev/null | grep -c '[d]aemon.sh'") || '0');
  check('重复拉起不产生第二守护', d2 === 1, `count=${d2}`);

  // --- 引擎被杀：守护应自动 force-stop + relaunch，桥恢复 ---
  if (!SKIP_RELAUNCH) {
    console.log('--- 注入引擎被杀 ---');
    const logBefore = sh('tail -1 /data/local/tmp/dsh-wb-bridge.log');
    sh(`am force-stop ${PKG}`);
    await sleep(3);
    // 守护可能在 3s 内就把引擎拉起来了，不断言「必须已停」，改看守护日志是否真的动作了
    console.log(`      force-stop 后 healthz=${httpCode('/healthz', 5)}`);
    const back = await waitHealth(100, '引擎重启');
    const logAfter = sh('tail -6 /data/local/tmp/dsh-wb-bridge.log');
    check('守护记录了拉起动作', logAfter !== logBefore && /port 19427 down|relaunch|launching/.test(logAfter),
      logAfter.split('\n').slice(-2).join(' | ').slice(0, 140));
    check('守护自动拉起引擎并恢复桥', back, back ? 'healthz=200' : '超时');
    forward();
  } else skip('引擎被杀自动拉起', '--skip-relaunch');

  // --- 连续三轮真实对话：验证上游链路 + 重试/降级稳定 ---
  console.log('--- 连续三轮上游对话 ---');
  const payload = JSON.stringify({ model: 'auto', stream: false, messages: [{ role: 'user', content: '只回 OK' }] });
  const tmp = 'chaos-body.json';
  fs.writeFileSync(tmp, payload);
  let okRounds = 0;
  const replies = [];
  for (let i = 1; i <= 3; i++) {
    forward();
    const r = curl(['-X', 'POST', `${BRIDGE}/v1/chat/completions`, '-H', 'Content-Type: application/json',
      '--data-binary', '@' + tmp, '-w', '\n%{http_code}'], 70);
    const parts = r.out.split('\n');
    const code = parts.pop().trim();
    let rep = null;
    try { rep = JSON.parse(parts.join('\n')); } catch { /* ignore */ }
    const good = code === '200' && !!(rep && rep.choices && rep.choices[0]);
    if (good) { okRounds++; replies.push(String(rep.choices[0].message?.content || '').slice(0, 24)); }
    console.log(`      round ${i}: http=${code} ${good ? 'ok' : 'fail'}`);
  }
  fs.unlinkSync(tmp);
  check('连续三轮对话全部成功', okRounds === 3, `${okRounds}/3 ${JSON.stringify(replies)}`);

  // --- 最终状态 ---
  console.log('--- 最终状态 ---');
  forward();
  const dg = getJson('/v1/diag');
  check('最终 healthz 200', httpCode('/healthz') === '200');
  check('最终无上游错误累计', !!dg && dg.stats.upstreamErrors === 0, dg ? JSON.stringify(dg.stats).slice(0, 160) : 'no diag');
  check('最终代码 golden 一致', sha(DST) === codeGold);
  check('最终配置 golden 一致', sha(DST_PATCH) === patchGold);
  check('最终守护仍唯一', Number(sh("ps -A -o ARGS 2>/dev/null | grep -c '[d]aemon.sh'") || '0') === 1);

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  const skips = results.filter((r) => r.ok === null).length;
  console.log(`\n=== SUMMARY === total=${results.length} pass=${pass} fail=${fail} skip=${skips}`);
  if (fail) console.log('FAILED: ' + results.filter((r) => r.ok === false).map((r) => r.name).join(' | '));
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), port: CUR_PORT, portRequested: PORT, wait: WAIT, results, pass, fail, skip: skips }, null, 2));
    console.log('report -> ' + OUT);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('chaos test crashed:', e); process.exit(2); });
