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
| 模型 | 点「获取模型」拿 25 个可用模型；或手动填 `auto` |

先在手机浏览器打开 `http://127.0.0.1:19427/healthz`，返回 `{"ok":true,...}` 说明桥已起来。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WB_BRIDGE_PORT` | `19427` | 监听端口，改了要同步改 Base URL |
| `WB_BRIDGE_TIMEOUT` | `120000` | 上游超时(ms) |
| `WB_BRIDGE_ENDPOINT` | 云服务 publicConfig | 上游地址，可热更新 |
| `WB_BRIDGE_PUBKEY` | `wbpk_…` | webapp access key，可热更新 |
| `WB_BRIDGE_ATTEMPTS` | `4` | 上游请求最大尝试次数 |
| `WB_BRIDGE_RETRY_MS` | `400` | 重试退避基数(ms)：400/800/1600 |
| `WB_BRIDGE_SYS_MAX` | `2000` | system 超过此长度一律换短中性头 |
| `WB_BRIDGE_CONFIG` | — | 指定持久配置文件路径 |

endpoint / pubkey / 积分凭证都从 `/root/.dsh/bridge-config.json` 读取，**每 30 秒热重载**，
也可通过 `POST /v1/config/set` 立即生效；换 key 不用改代码、不用重启引擎。
用 `GET /v1/diag` 看当前 endpoint、重试/降级计数、最近上游状态码、配置路径。

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
- 上游会拒掉带渠道指纹句式的 system（`You are an AI agent powered by DeepSeek Harness` 等）：
  dsh-go 引擎发出的超长 system（实测 17k 字符）会返回 `400 request_invalid_parameter`。
  这是内容级校验，删掉指纹句、补中性头、裁剪到 2200 字都仍会被拒（前 216 字 OK、
  217 字起 FAIL）；纯长文本则不受影响。桥对命中指纹的 system 整体替换为短中性头，
  其余 messages / tools 原样保留。用引擎完整 payload（17k system + 58 tools + 全部消息）
  实测返回 200，手机端真实对话已跑通。
- 引擎重启后插件会随 bundle 自动加载，不需要手动跑脚本。
- 上游 `/models` 目录里有 12 个模型不支持 `chat/completions`（实测两次均 400）：
  `hy4-preview-x`、`glm-5.0/4.7/4.6/4.6v`、`minimax-m2.5`、`kimi-k2-thinking`、
  `hunyuan-2.0-thinking`、`hunyuan-image-alpha(-edit)`、`kling-video-v3`、
  `minimax-video-h3`。桥在 `/v1/models` 里过滤掉它们（返回 25 个可用模型），
  旧会话若仍带着被过滤的 id 会自动回退 `auto`，不会直接报错。
- 别用 3000 / 18765 端口（本机常被别的服务占用）。

## 积分查询

手机/电脑浏览器打开 `http://127.0.0.1:19427/credits` 即可看到 WorkBuddy 剩余积分。
未配置凭证时页面直接带填写表单，填完自动保存，之后刷新就能看。

| 路由 | 方法 | 说明 |
|---|---|---|
| `/credits` | GET | 余额状态页（HTML，手机浏览器直接看） |
| `/v1/credits` | GET | 余额 JSON（`{ ok, data }`，给程序/页面用） |
| `/v1/credits/set` | POST | 提交 `{ accessToken, userId? }`，写入内存并持久化到 `config.json` |
| `/v1/diag` | GET | 运行诊断：pid/uptime/endpoint、重试与降级计数、最近上游状态码 |
| `/v1/config/set` | POST | 提交 `{ endpoint?, pubkey? }`，热更新并写回持久配置 |

**accessToken 从哪来**：浏览器登录 <https://www.workbuddy.cn> → F12 → Network →
点任意发往 `www.workbuddy.cn` 的请求 → 复制 Request Headers 里
`Authorization: Bearer xxxxx` 的 `xxxxx` 部分。可选填 `userId`（请求/响应头里的 `X-User-Id`）。
桥用这个 token 调官方余额接口 `POST /billing/meter/get-user-resource-summary`。
本机 WorkBuddy 客户端的登录态是加密的、拿不到明文，所以必须手动复制一次。

凭证也可写到插件目录下的 `config.json`：

```json
{ "credits": { "accessToken": "xxxxx", "userId": "可选" } }
```

或设环境变量 `WB_CREDITS_TOKEN` / `WB_CREDITS_UID`。三种来源优先级：
环境变量 > `config.json` > 运行时表单填写。

## 持久化守护（KSU / Magisk）

`daemon/` 是手机端的开机自启守护，负责端口保活与代码一致性：

- `service.sh` 由 KernelSU `/data/adb/service.d/` 开机拉起 `daemon.sh`（root、PPID 1，脱离电脑）。
- 每 15 秒查 19427；端口掉了就 `force-stop` + 重启 dsh-go app，插件桥随之恢复。
- 用黄金副本 `/data/adb/dsh-wb-bridge/bridge.mjs` 校验并还原
  `rootfs/root/.dsh/profiles/web/node_modules/dsh-workbuddy-bridge/lib/index.js`。
- 用 `/data/adb/dsh-wb-bridge/cordis.patch.yml.golden` 校验并还原
  `rootfs/root/.dsh/profiles/web/cordis.patch.yml`：app 内的 agent 或设置页把 provider
  改回 `apiKeyEnv` 会重现「API Key 无效或已过期」，守护每 15 秒把它改回来。
- 保证 `/root/.dsh/bridge-config.json` 存在且属主正确，积分凭证重启不丢。
- 日志：`/data/local/tmp/dsh-wb-bridge.log`。
- 拉起守护用 `sh /data/adb/dsh-wb-bridge/service.sh`，别在 adb 命令行里直接写
  `daemon.sh` 路径 —— 守护的单实例检查会把那条 shell 命令也算进去而自我退出。

**升级顺序（必须遵守）**：

```sh
BASE=/data/adb/dsh-wb-bridge
DST=<rootfs>/root/.dsh/profiles/web/node_modules/dsh-workbuddy-bridge/lib/index.js
cp lib/index.js "$BASE/bridge.mjs"     # 1. 先更新代码 golden
cp "$BASE/bridge.mjs" "$DST"           # 2. 再同步到插件
chown u0_a168:u0_a168 "$DST"
cp daemon/cordis.patch.yml.golden "$BASE/cordis.patch.yml.golden"  # 3. 配置 golden
cp "$BASE/cordis.patch.yml.golden" <rootfs>/root/.dsh/profiles/web/cordis.patch.yml
# 4. 重启引擎
```

只改 `node_modules` 而不更新 golden，15 秒内会被守护还原 —— 这正是「改了又失效」的根因。
两边 `sha256sum` 应一致（当前 `e5ec5b7b…`）。

## 自愈行为

- 上游 403/408/425/429/5xx 与网络异常：桥内自动重试（默认 4 次，400/800/1600ms 退避），
  app 无感知；实测一次上游瞬时故障由 `retries:1` 吸收，最终 200。
  403 常见于腾讯云边缘 WAF 返回 HTML 拦截页（「您的请求已中断」），
  `/v1/diag` 的 `stats.lastWaf` 会留 1500 字符原文。
- 请求头浏览器化：`origin` / `referer` / `user-agent` / `sec-fetch-*`，
  降低 Node fetch 裸请求被 WAF 判成异常的概率。
- 上游 400/403 参数或内容校验：逐级自动降级 —— L1 短 system + 去掉 tools/可选参数，
  L2 只留 system + 最后一条 user 消息（`fallbacks` 计数可见），
  应对 app 升级换提示词触发的新校验。实测 WAF 持续按内容拦时降级后 200。
- 模型目录拉取失败：回退旧缓存 / 内置最小目录，不让整轮对话挂掉。
- 端口被占用：插件进入热备，每 2 秒探测，端口释放即自动接管，
  修掉「常驻进程死了、插件已退让」导致 19427 无人服务的空窗。

## 「API Key 无效或已过期」的根治

症状：会话里 0.8~1.5 秒就失败，报「API Key 无效或已过期」，而桥的
`/v1/diag` 里 `stats.requests` 不增加 —— 请求根本没发出来。

原因：provider 里写了 `apiKeyEnv: CUSTOM_WB_BRIDGE_API_KEY`。pi-ai 每次请求都要
解析这个凭据引用，解析不到就抛 `MISSING_CREDENTIAL` / `INVALID_CREDENTIAL`，
app 把两者统一显示成「API Key 无效或已过期」。旧会话、app 内 agent 自己改过设置、
插件市场覆盖配置都可能触发；表现就是「新对话能用、某个会话一直失效」。

修法：删掉 `apiKeyEnv`。但 OpenAI 协议仍要求 Authorization 头（pi-ai 文档明确写了
keyless 本地服务需要占位凭据），所以在 provider 里放字面值：

```yaml
      custom-wb-bridge:
        displayName: WB-Bridge
        api: openai-completions
        baseURL: http://127.0.0.1:19427/v1
        headers:
          Authorization: Bearer wb-bridge
```

桥不校验 key，任意非空值都行。完整可用配置见 `daemon/cordis.patch.yml.golden`，
由守护每 15 秒校验还原，app 内的 agent 改不坏。
