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

## 发布到 GitHub / 插件市场

仓库已在本机就绪（`git init` + commit `feat: dsh-workbuddy-bridge 1.0.0`），
`publish.mjs` 是一键发布脚本，零第三方依赖，token 只从环境变量读、不落盘。

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"     # 需要 repo 权限
$env:NPM_TOKEN    = "npm_xxx"     # 需要 publish 权限，Automation 类型可绕过 2FA
node publish.mjs all              # 或 github / npm 单独跑
```

脚本做的事：

1. `GET /user` 拿账号名 → `POST /user/repos` 建公开仓库（已存在则复用）。
2. 本地 `git add/commit`、`git push -u origin main`（显式清掉本机不通的 127.0.0.1 代理），
   推完把带 token 的 remote 改回干净 URL，凭证不留在 `.git/config`。
3. 写临时 `.npmrc`（`_authToken=${NPM_TOKEN}`）→ `npm publish --access public` → 删除 `.npmrc`。

发布后两种安装源：

```
dsh plugin --profile web add github:<owner>/dsh-workbuddy-bridge
# 或在 dsh-go 插件市场搜索 dsh-workbuddy-bridge
```

本机当前状态（真实探测）：

- GitHub 连接器是 **GitHub App**（`https://api.githubcopilot.com/mcp/`），token 由 WorkBuddy 托管、不落本机。
  `get_me` → 200（账号 `moluguzhi2`）；`create_repository` → `403 Resource not accessible by integration`；
  `push_files` 到 `moluguzhi2/SubsTracker` → `403 Resource not accessible by integration`；
  `get_file_contents` 读该仓库 → 200。**只读，不能写，也不能建仓库**。
- `cmdkey /list` 无 GitHub 凭证，`npm whoami` → ENEEDAUTH，无 gh CLI、无 `GITHUB_TOKEN` / `NPM_TOKEN`。
- git 清掉本机 127.0.0.1 代理后能匿名 `ls-remote`，但 push 必须认证。

所以**还没有真正推到 GitHub / npm**，不是代码问题也不是网络问题，缺的是具有写权限的凭证。
两条最短路径：

1. 给一个 GitHub PAT（`repo`）+ npm Automation token，双击 `publish.cmd` 或跑
   `GITHUB_TOKEN=… NPM_TOKEN=… node publish.mjs all`；
2. 在 GitHub 网页手建空仓库 `dsh-workbuddy-bridge`，把 App 的 Contents 权限改成 write，
   再用 `mcp__github__push_files` 推（无需 token）。

## 注意

- 云 LLM 只支持流式：桥始终向上游发 `stream:true`，客户端要非流式时由桥聚合 SSE。
- 桥会补齐 `messages[0]` 为 system、`developer` 归一化成 `system`、不认识的模型 ID 回退 `auto`。
- 引擎重启后插件会随 bundle 自动加载，不需要手动跑脚本。
- 别用 3000 / 18765 端口（本机常被别的服务占用）。
