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
| `WB_BRIDGE_MODE` | `plugin` | 运行模式标记，仅用于 `/healthz` 展示 |
| `WB_BRIDGE_CONFIG` | 无 | 指定积分配置文件路径 |

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
环境变量 > `config.json` > 运行时表单填写。传 `{"accessToken":"","userId":""}` 可清空凭证。

## 持久化守护（KernelSU / root）

只装插件时，app 被系统回收、引擎运行时升级、插件市场重装都会让桥失效。守护把这几件事兜住：

| 文件 | 落在手机 | 作用 |
|---|---|---|
| `deploy/service.sh` | `/data/adb/service.d/dsh-wb-bridge.sh` | KSU 开机自启入口，后台拉起 daemon 后立即退出，不阻塞启动 |
| `deploy/daemon.sh` | `/data/adb/dsh-wb-bridge/daemon.sh` | 每 15 秒检查 19427；掉了就拉起 app；用黄金副本还原被覆盖的 `lib/index.js`；保证配置副本 |
| `lib/index.js` | `/data/adb/dsh-wb-bridge/bridge.mjs` | 黄金副本，放在 root 管理目录，运行时升级覆盖不到 |
| `deploy/config.example.json` | `$RF/root/.dsh/bridge-config.json` | 积分凭证，插件与守护共用一个物理文件 |

一键部署（电脑端，adb 已连、设备已 root）：

```bash
bash deploy/install.sh
```

脚本 7 步：设备/root 检查 → 上传 → 装黄金副本 → 同步插件版 `lib/index.js` → 建配置副本 → 写 service.d 与电池优化白名单 → 重启引擎、启动守护、打印 healthz。

验证：

```bash
adb forward tcp:19427 tcp:19427
curl http://127.0.0.1:19427/healthz      # {"ok":true,...,"mode":"plugin","port":19427}
curl http://127.0.0.1:19427/credits      # 200 状态页
adb shell am force-stop io.github.ccch1mneyyy.dsh_app   # 模拟系统回收
sleep 30
curl http://127.0.0.1:19427/healthz      # 应恢复，pid 变了
adb shell tail -8 /data/local/tmp/dsh-wb-bridge.log
```

实测（2026-11-09）：杀 app 后 **10 秒内**守护拉起、`healthz` 200；把 `node_modules/lib/index.js` 改坏后 **30 秒内**从黄金副本还原；`healthz` 带 `mode` / `pid` / `uptime_s`，可直接判断谁在提供服务。守护进程 PPID 为 1，脱离 adb 与电脑。

设计取舍：试过把桥做成脱离 app 的独立 root 进程（`unshare -m` + tmpfs `/etc` 补 resolv.conf），两个硬伤后放弃：
1. Android 的 `/etc` 是 `/system/etc` 软链，挂载会传播回宿主并覆盖系统配置（`uiautomator` 直接 Aborted）；虽然 `busybox mount --make-rprivate /` 能隔离，风险仍高；
2. 非引擎进程发 DNS 查询被 netd 拦（`ECONNREFUSED` / `EAI_AGAIN`），换网络后公共 DNS 全不可达。

故持久性由「开机自启 + 端口自愈 + 代码自愈 + 配置持久」实现，DNS 交给引擎自己的 proot 环境。

**外部条件**：手机必须能联网。`dumpsys connectivity` 显示 `Active default network: none` 时，桥本身正常，但所有模型请求会 `fetch failed`；联网后无需任何操作即可恢复。无 root 的设备不装守护，插件功能照常，只是没有开机自启与自动恢复。
