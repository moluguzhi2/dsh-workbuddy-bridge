#!/usr/bin/env node
/**
 * 一键发布 dsh-workbuddy-bridge 到 GitHub 和/或 npm。
 *
 * 用法（PowerShell）：
 *   $env:GITHUB_TOKEN="ghp_xxx"; node publish.mjs github
 *   $env:NPM_TOKEN="npm_xxx";     node publish.mjs npm
 *   $env:GITHUB_TOKEN="ghp_xxx"; $env:NPM_TOKEN="npm_xxx"; node publish.mjs all
 *
 * 用法（Git Bash）：
 *   GITHUB_TOKEN=ghp_xxx node publish.mjs github
 *   NPM_TOKEN=npm_xxx node publish.mjs npm
 *
 * GitHub token 需要 repo 权限；npm token 需要 publish 权限（Automation 类型可绕过 2FA）。
 * token 只从环境变量读取，不写进任何文件、不打印。
 * 零第三方依赖：Node 内置 fetch + child_process。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'dsh-workbuddy-bridge';
const DESCRIPTION = 'DSH/dsh-go plugin: OpenAI-compatible bridge to WorkBuddy Cloud LLM';
const mode = (process.argv[2] || 'all').toLowerCase();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const NPM_TOKEN = process.env.NPM_TOKEN || '';

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write('FAIL ' + msg + '\n'); process.exit(1); }

/** 本机 git 默认走一个不通的 127.0.0.1 代理，发布时显式清掉。 */
function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
  return env;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: HERE, encoding: 'utf8', ...opts, env: cleanEnv(opts.env) });
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')}: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  return (r.stdout || '').trim();
}

async function ghApi(pathname, init = {}) {
  const r = await fetch('https://api.github.com' + pathname, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: `Bearer ${GITHUB_TOKEN}`,
      'user-agent': 'dsh-workbuddy-bridge-publisher',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, body };
}

async function publishGithub() {
  if (!GITHUB_TOKEN) fail('GITHUB_TOKEN not set');
  const me = await ghApi('/user');
  if (me.status !== 200) fail(`GET /user -> ${me.status} ${JSON.stringify(me.body).slice(0, 200)}`);
  const owner = me.body.login;
  log(`GitHub account: ${owner}`);

  let created = false;
  const make = await ghApi('/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: REPO, description: DESCRIPTION, private: false, auto_init: false, has_issues: true }),
  });
  if (make.status === 201) { created = true; log(`Created repo ${owner}/${REPO}`); }
  else if (make.status === 422) log(`Repo ${owner}/${REPO} already exists, reusing`);
  else fail(`POST /user/repos -> ${make.status} ${JSON.stringify(make.body).slice(0, 200)}`);

  // 本地仓库就绪：init / commit / 打 tag
  if (!fs.existsSync(path.join(HERE, '.git'))) {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', owner]);
    run('git', ['config', 'user.email', `${owner}@users.noreply.github.com`]);
  }
  run('git', ['add', '-A']);
  const status = run('git', ['status', '--porcelain']);
  if (status) run('git', ['commit', '-q', '-m', 'feat: dsh-workbuddy-bridge 1.0.0']);
  run('git', ['branch', '-M', 'main']);

  const remote = `https://${GITHUB_TOKEN}@github.com/${owner}/${REPO}.git`;
  // remote 不存在时 remove 会报错，用不抛错的形式先清掉
  spawnSync('git', ['remote', 'remove', 'origin'], { cwd: HERE, stdio: 'ignore', env: cleanEnv() });
  run('git', ['remote', 'add', 'origin', remote]);
  run('git', ['-c', 'http.proxy=', 'push', '-u', 'origin', 'main', '--force']);
  // 推送后把带 token 的 remote 改回干净 URL，避免凭证留在 .git/config
  run('git', ['remote', 'set-url', 'origin', `https://github.com/${owner}/${REPO}.git`]);

  const url = `https://github.com/${owner}/${REPO}`;
  log(`GitHub OK: ${url}  (${created ? 'created' : 'updated'})`);
  log(`Install from GitHub: dsh plugin --profile web add github:${owner}/${REPO}`);
  return url;
}

function publishNpm() {
  if (!NPM_TOKEN) fail('NPM_TOKEN not set');
  const npmrc = path.join(HERE, '.npmrc');
  const backup = fs.existsSync(npmrc) ? fs.readFileSync(npmrc) : null;
  fs.writeFileSync(npmrc, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
  try {
    const r = spawnSync('npm', ['publish', '--access', 'public', '--registry', 'https://registry.npmjs.org'], {
      cwd: HERE,
      encoding: 'utf8',
      env: cleanEnv({ NPM_TOKEN }),
    });
    if (r.status !== 0) fail(`npm publish: ${(r.stderr || r.stdout || '').slice(0, 600)}`);
    log((r.stdout || '').trim());
    log('npm OK: https://www.npmjs.com/package/dsh-workbuddy-bridge');
    log('Install from market: search "dsh-workbuddy-bridge" in dsh-go plugin market');
  } finally {
    // 凭证不落盘
    if (backup !== null) fs.writeFileSync(npmrc, backup);
    else fs.unlinkSync(npmrc);
  }
}

(async () => {
  if (!['github', 'npm', 'all'].includes(mode)) fail('usage: node publish.mjs github|npm|all');
  if (mode === 'github' || mode === 'all') await publishGithub();
  if (mode === 'npm' || mode === 'all') publishNpm();
  log('DONE');
})();
