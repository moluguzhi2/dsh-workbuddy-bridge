# dsh-workbuddy-bridge

DSH / dsh-go 插件。引擎加载时在 `127.0.0.1:19427` 起一个 OpenAI 兼容桥，
把模型请求转到 **WorkBuddy 云 LLM**（`/.cloud/llm/**`）。

为什么需要它：`https://copilot.tencent.com/v2` 直连会被上游渠道指纹拦
（`11128 Illegal API invocation from an unapproved channel`）—— DSH 引擎发的
system 开头命中了官方客户端校验。云 LLM 这条链路不做该校验，插件负责转发，
所以 dsh-go 里能正常聊天，消耗的是 WorkBuddy 积分。

```
dsh-go ──> http://127.0.0.1:19427/v1 ──> 插件桥 ──> WorkBuddy 云 LLM
              (loopback, 无 ?/#)                     /.cloud/llm/chat/completions
```

- 电脑不用开机；插件跑在手机本机引擎里。
- Base URL 是 loopback，Android 允许明文 HTTP；不含 `?` / `#`，dsh-go 的校验能过。
- 零第三方依赖，只用 Node 内置 `http` + `fetch`。

## 安装

包文件：`../dsh-workbuddy-bridge-1.0.0.tgz`（上一级 `plugin/` 目录，由 `npm pack` 生成）。
本目录 `dsh-workbuddy-bridge/` 是解压后的源码，两者内容一致。

**A. 插件市场 / 网页版支持本地包时**：把 tgz 传到手机，在
`设置 › 插件` 里选本地包安装，然后按提示重启引擎。

**B. 手工放进引擎**（需要能在手机上操作引擎文件，例如网页版的文件管理）：

1. 解压 tgz，把 `package/` 整个目录放到
   `~/.dsh/profiles/<profile>/node_modules/dsh-workbuddy-bridge/`。
2. 在 `~/.dsh/profiles/<profile>/package.json` 的
   `dsh.profile.bundles` 数组里加一行 `"dsh-workbuddy-bridge"`。
   `cordis.patch.yml` 会由 `dsh.bundle.patch` 自动应用，不用手改。
3. `设置 › 本机引擎 › 重启`。

引擎日志出现 `[workbuddy-bridge] OpenAI bridge on http://127.0.0.1:19427/v1` 即加载成功。

## dsh-go 里填

`设置 › 模型 › 添加渠道`：

| 字段 | 值 |
|---|---|
| 兼容协议 | `OpenAI` |
| Base URL | `http://127.0.0.1:19427/v1` |
| API Key | 任意值（桥不校验），例如 `wb-bridge` |
| 模型 | 点「获取模型」拿 37 个；或手动填 `auto` |

先在手机浏览器打开 `http://127.0.0.1:19427/healthz`，返回 `{"ok":true,...}` 说明桥已起来。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WB_BRIDGE_PORT` | `19427` | 监听端口，改了要同步改 Base URL |
| `WB_BRIDGE_TIMEOUT` | `120000` | 上游超时(ms) |

上游 endpoint 与 publishableKey 写在 `lib/index.js` 顶部常量里，来自 WorkBuddy
云服务的 publicConfig（公开可分发，不含长期密钥）。

## 发布状态与安装源

**GitHub 公开仓库（已上线）**：`https://github.com/moluguzhi2/dsh-workbuddy-bridge`
分支 `main`，含 8 个文件：`.gitignore` / `LICENSE` / `README.md` / `cordis.patch.yml` /
`package.json` / `lib/index.js` / `publish.mjs` / `test/smoke.mjs`。

### 从 GitHub 直接安装（推荐，不需要 npm 账号）

```bash
# 通用 npm 安装，实测 added 1 package，落地 node_modules/dsh-workbuddy-bridge/
npm install https://codeload.github.com/moluguzhi2/dsh-workbuddy-bridge/tar.gz/refs/heads/main

# 或 dsh-go 原生命令
dsh plugin --profile web add github:moluguzhi2/dsh-workbuddy-bridge
```

已实测可解析的两条 tarball 源：

| 源 | 结果 |
|---|---|
| `https://codeload.github.com/moluguzhi2/dsh-workbuddy-bridge/tar.gz/refs/heads/main` | 200，10.5 kB，11 文件，gzip OK |
| `https://quiz-helper-68853.app.workbuddy.host/dsh-workbuddy-bridge-1.0.0.tgz?sharecode=X5W37ULDJF` | 200，6.7 kB，5 文件，gzip OK |

### 不要从 npm 市场名安装

npm 上的 `dsh-workbuddy-bridge` 已被第三方账号 `zayninnpm` 占用（最新 `0.5.7`，
同为 WorkBuddy → DeepSeek Harness 主题，用 GitHub Actions OIDC 发布）。
`npm i dsh-workbuddy-bridge` 会装到**别人的包**，不是本仓库的 1.0.0。
上面的 GitHub tarball 直装不受影响——包名由本地 `package.json` 决定，仍落在
`node_modules/dsh-workbuddy-bridge/`，与 `cordis.patch.yml` 里的 `name` 一致。

### 本仓库的发布脚本

`publish.mjs` 保留为可选的一键发布入口（零第三方依赖，token 只从环境变量读、不落盘），
需要自己有 npm 账号的 Automation token：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"     # repo 权限
$env:NPM_TOKEN    = "npm_xxx"     # publish 权限，Automation 类型绕过 2FA
node publish.mjs all              # 或 github / npm 单独跑
```

脚本做三件事：`POST /user/repos` 建公开仓库（已存在则复用）、`git push -u origin main`
（显式清掉本机不通的 127.0.0.1 代理，推完把带 token 的 remote 改回干净 URL）、
写临时 `.npmrc` → `npm publish --access public` → 删除 `.npmrc`。

## 注意

- 云 LLM 只支持流式：桥始终向上游发 `stream:true`，客户端要非流式时由桥聚合 SSE。
- 桥会补齐 `messages[0]` 为 system、`developer` 归一化成 `system`、不认识的模型 ID 回退 `auto`。
- 引擎重启后插件会随 bundle 自动加载，不需要手动跑脚本。
- 别用 3000 / 18765 端口（本机常被别的服务占用）。
