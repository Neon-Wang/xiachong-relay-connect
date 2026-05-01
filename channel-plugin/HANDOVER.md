# Channel Plugin 交接文档（HANDOVER）

> **写这份文档的目的**：让任何新接手 EvoPaimo channel plugin 的人（或 AI agent）在 30 分钟内能完成"端到端连一遍"，并在踩坑时知道去哪查。
>
> **撰写日期**：2026-04-22。下次大改动后请同步更新（修改时间标在最末尾）。

---

## 0. TL;DR

| 你想做什么 | 跳到 |
|---|---|
| **首次拉起 channel plugin 让 EvoPaimo 客户端能聊天** | [§1 端到端连接流程](#1-端到端连接流程稳态版本) |
| **发新版插件** | [§2 日常发版流程（稳态）](#2-日常发版流程稳态) |
| **部署 / 修改 Cloudflare Workers** | [§3 Workers 部署清单](#3-workers-部署清单) |
| **看哪个组件由哪个文件控制** | [§4 cheatsheet](#4-cheatsheet--文件配置workflow-索引) |
| **解释每一个"为什么这样写"的适配事项** | [§5 适配事项总览](#5-适配事项总览必读) |
| **重启 npm 发布通道** | [§6 npm 通道重启清单](#6-npm-通道重启清单) |
| **故障排查 / 常见症状 → 原因 → 处置** | [§7 故障速查](#7-故障速查) |

---

## 1. 端到端连接流程（稳态版本）

> 描述用户从零开始，让 EvoPaimo 桌面客户端通过 channel plugin 与 OpenClaw 完整跑通的完整路径。中间的每一步都已通过 VM 实测（2026-04-22，Debian 12 + OpenClaw 2026.4.5）。

```
[Electron 客户端]
    │   ① 打开"连接管理" → 生成 linkCode + secret
    ▼
[Cloudflare Workers Relay]
    │   ② 持久化 link_code → secret 配对，等 plugin 用 /api/link 兑换 agent_token
    │
[OpenClaw Gateway]
    │   ③ 装上 @evopaimo/channel 插件（tarball 来自 R2 或 GitHub Release）
    │   ④ 配置 ~/.openclaw/openclaw.json 的 channels.evopaimo
    │   ⑤ openclaw gateway start → plugin 自动 pair + 建立 WebSocket
    ▼
[EvoPaimo 客户端] 发消息 → Workers → plugin → OpenClaw agent → 反向回流
```

### Step 1 — 拿一份能用的插件 tarball（任选一条腿）

#### 腿 A：从 R2 拉最新版（推荐国内用户、CI 自动通道）

```bash
# 生产环境（默认）
curl -fL -o evopaimo-channel.tgz \
  https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz
curl -fL https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.sha256 \
  | shasum -a 256 -c -
# 输出：evopaimo-channel.tgz: OK

# Staging（dev 联调）
curl -fL -o evopaimo-channel.tgz \
  https://primo.evomap.ai/channel-plugin/latest.tgz
```

#### 腿 B：从 GitHub Release 拉指定版（推荐审计、版本锁定）

```bash
VERSION="0.1.1"
curl -fL -o evopaimo-channel.tgz \
  "https://github.com/EvoMap/XiaChong/releases/download/channel-plugin-v${VERSION}/evopaimo-channel-${VERSION}.tgz"
curl -fL -o latest.sha256 \
  "https://github.com/EvoMap/XiaChong/releases/download/channel-plugin-v${VERSION}/latest.sha256"
shasum -a 256 -c latest.sha256
```

#### 腿 C（PENDING）：~~`openclaw plugins install @evopaimo/channel`~~

**当前不可用**。详情和重启步骤见 [§6](#6-npm-通道重启清单)。

> 所有三条腿（包括将来重启的 npm 通道）由同一次 CI 构建产出，sha256 字节相同。

### Step 2 — 装到 OpenClaw

```bash
openclaw plugins install ./evopaimo-channel.tgz
# 如果之前装过、要覆盖：
# openclaw plugins install --force ./evopaimo-channel.tgz
```

> ⚠️ **0.1.0 重装陷阱**：如果之前装过 0.1.0 preview 又把 `~/.openclaw/extensions/evopaimo/` 手动删了，但 `openclaw.json` 还留着 `channels.evopaimo`，会报 `Invalid config: channels.evopaimo: unknown channel id`。处置脚本见 [`README.md › Re-install gotcha`](./connector-channel-plugin-README.md#re-install-gotcha)。

### Step 3 — 拿 `linkCode + secret`（来自 Electron 客户端）

| 客户端模式 | 怎么拿 |
|---|---|
| 生产 build | "设置 → 连接管理" → "生成新的配对码"，UI 显示 6 位 `linkCode` + 64 位 hex `secret` |
| dev build (`pnpm electron:dev`) | Electron 主进程会把这对凭证打到 stderr：`grep -E '\[evopaimo\] (linkCode|secret)='` |
| dev build（自动化测试） | 调 `client/electron/test-server.js` 暴露的 `127.0.0.1:11453/exec` `cmd: credentials`（需 Bearer token） |

> 一对 `linkCode + secret` 终生绑定到一台 OpenClaw 宿主机。在客户端"连接管理"重新生成会作废旧凭证，旧 OpenClaw 端会在下次重连时收 401。

### Step 4 — 写 `~/.openclaw/openclaw.json`

```jsonc
{
  "plugins": {
    "allow": ["evopaimo"]   // 强烈推荐：杜绝意外加载第三方插件
  },
  "channels": {
    "evopaimo": {
      "relayUrl": "https://xiachong-api.aged-sea-ee35.workers.dev",
      "linkCode": "ABC123",
      "secret":   "<64-hex-chars-from-electron-client>",
      "sessionLabel": "mobile-app",
      "emotionWrapperEnabled": true,
      "allowFrom": ["*"]    // 必加，否则 audit 报 CRITICAL；解释见 §5.2
    }
  }
}
```

字段含义详见 [`INSTALL.md` §5](./INSTALL.md#5-配置-openclawjson)。**关键：`relayUrl` 必须是 `https://`**——0.1.1 起插件启动时会拒绝任何非 https scheme（防止凭证以明文泄露），见 §5.1。

### Step 5 — 启动 Gateway + 验证

```bash
openclaw gateway start
journalctl --user -u openclaw-gateway -f   # macOS: tail -F ~/.openclaw/logs/gateway.log
```

期望按顺序看到：

```text
[evopaimo] started account default (relay=https://xiachong-api.aged-sea-ee35.workers.dev)
[evopaimo] evopaimo-ws: pairing: trying agent-auth with stored agent_token
[evopaimo] paired via agent-auth (appId=openclaw_xxxx agentId=agent_xxxx)
   # 或首次：paired via link (...)
[evopaimo] evopaimo-ws: connecting accountId=default relayUrl=…
[evopaimo] evopaimo-ws: open accountId=default
```

> 看到 `[default] auto-restart attempt N/10` = 故障，跳 [§7.5](#75-反复-auto-restart-attempt-n10)。

冒烟测试：在 Electron 客户端发"你好"，~20 秒内（kimi/k2p5 中位响应）应收到带情绪表情的回复。

---

## 2. 日常发版流程（稳态）

> 当前生效的发版完全由 CI 驱动。无人工 npm 操作（npm 通道 PENDING）。

### 2.1 改代码 → 发版的最短路径

```bash
# 1) 在 connector/channel-plugin/ 下做你的改动
cd connector/channel-plugin
# ...edit src/, run tests etc.
pnpm ci   # typecheck + test + build + attack-sim 一气呵成

# 2) bump 版本号（语义化）
#    patch (0.1.1 → 0.1.2): bug fix / 内部重构
#    minor (0.1.x → 0.2.0): 配置 schema 新增可选字段、wire 协议向后兼容扩展
#    major (0.x   → 1.0.0): 配置 schema breaking change、wire 协议 breaking change
vim package.json   # 或 pnpm version patch / minor / major

# 3) 写 CHANGELOG（Keep a Changelog 风格）
vim CHANGELOG.md

# 4) commit + push 到 main
git add package.json CHANGELOG.md src/...
git commit -m "release(channel-plugin): vX.Y.Z — <one-line summary>"
git push origin main

# 5) 打 tag + push（会触发 CI 创 GitHub Release）
git tag channel-plugin-vX.Y.Z
git push origin channel-plugin-vX.Y.Z
```

### 2.2 CI 自动做的事

`Publish Channel Plugin` workflow（`.github/workflows/publish-channel-plugin.yml`）会：

1. `pnpm install --frozen-lockfile` + typecheck + test + build + attack-sim
2. `pnpm pack` → `evopaimo-channel-X.Y.Z.tgz`，算 sha256
3. 生成 `latest.sha256`（shasum 格式）和 `latest.json`（含 `name/version/sha256/size/releasedAt/gitSha/downloads`）
4. **R2 上传 4 件套到两个 bucket**：
   - `xiachong-connector-staging/channel-plugin/v<ver>.tgz` + `latest.tgz` + `latest.sha256` + `latest.json`
   - `xiachong-connector-prod/channel-plugin/v<ver>.tgz` + `latest.tgz` + `latest.sha256` + `latest.json`
5. **如果是 tag 推送**：再创建 GitHub Release `channel-plugin-vX.Y.Z`，挂载 tarball + sha256 + json
6. ~~npm publish~~ — **PENDING**，已注释，详见 [§6](#6-npm-通道重启清单)

CI 跑完后，下面这些 URL **立即生效**（缓存策略由 `workers/src/api/channel-plugin.ts` 控制）：

| URL | Cache-Control | 描述 |
|---|---|---|
| `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz` | `max-age=300`（5 分钟） | 跟着最新版变 |
| `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/v<semver>.tgz` | `max-age=31536000, immutable` | 永不变 |
| `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.sha256` | `max-age=60` | 跟着最新版变 |
| `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.json` | `max-age=60` | 跟着最新版变 |
| `https://primo.evomap.ai/channel-plugin/...` | 同上 | Staging 镜像，dev 联调用 |

### 2.3 验证发版是否成功

```bash
# 1) GitHub Actions 跑完
gh run list --workflow="Publish Channel Plugin" --limit 3

# 2) R2 直链拉得到、sha256 对得上
curl -fI https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/v0.1.2.tgz
curl -fsSL https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.json | jq .version

# 3) GitHub Release 在
gh release view channel-plugin-v0.1.2 --repo EvoMap/XiaChong

# 4) 在 VM smoke
ssh xc-debian "
  curl -fL -o /tmp/p.tgz https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz && \
  openclaw plugins install --force /tmp/p.tgz && \
  openclaw gateway restart
"
```

### 2.4 回滚

R2 的 `v<semver>.tgz` 是 immutable，回任意旧版只需把 `latest.tgz` 复盖成对应旧版即可：

```bash
# 在 workers 目录用 wrangler；或者直接在 Cloudflare 控制台手动 copy R2 对象
cd workers
wrangler r2 object get xiachong-connector-prod/channel-plugin/v0.1.0.tgz --file /tmp/old.tgz
wrangler r2 object put  xiachong-connector-prod/channel-plugin/latest.tgz --file /tmp/old.tgz \
  --content-type "application/gzip" --remote
# 重新生成 latest.sha256 / latest.json 也同理
```

更稳的做法：**重打 tag**——在旧版 commit 上 `git tag channel-plugin-v0.1.0-republish && git push origin channel-plugin-v0.1.0-republish`。CI 会重新走一遍 §2.2 全流程，覆盖 latest。

---

## 3. Workers 部署清单

### 3.1 谁负责部署 Workers

通常由 channel plugin 维护者顺手做（一起改，一起发）。要点是 **Workers 端不要 lag 在插件后面**——`channel-plugin/*` 路由由 `workers/src/api/channel-plugin.ts` 实现，路由本身改了就要重发 Workers。

### 3.2 必读环境变量

| 变量 | 期望值 | 来源 | 注意 |
|---|---|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | `7a3d6232d52a3cb9123ceee7e5538edf`（**Admin@autogame.ai** 账号） | GitHub Secrets / 本地 `.dev.vars` | **不要**用 `9e17cd2512fe5dc7aa8bd8b09ed250e9`（Bigdangg@gmail.com 个人账号），那是 2026-04-22 部署事故的根源 |
| `CLOUDFLARE_API_TOKEN` | scoped token，含 R2/Workers/D1/KV 写权限 | GitHub Secrets | 仅 CI 使用；本地用 `wrangler login` 走 OAuth |
| `JWT_SECRET` | 已设 | `wrangler secret put` | 改了会让所有现存用户 token 全失效 |
| `ENCRYPTION_KEY` | 已设 | `wrangler secret put` | 同上 |

### 3.3 部署命令

```bash
cd workers
pnpm typecheck                          # 必做，CI 也跑这一步
pnpm test
CLOUDFLARE_ACCOUNT_ID=7a3d6232d52a3cb9123ceee7e5538edf pnpm deploy:staging
CLOUDFLARE_ACCOUNT_ID=7a3d6232d52a3cb9123ceee7e5538edf pnpm deploy:production
```

> 本地部署需要 Docker daemon 在跑（Workers 里 `AvatarGenContainer` Durable Object 依赖 container）。macOS 用 OrbStack 即可。

### 3.4 部署后验证

```bash
# Production
curl -fsSL https://xiachong-api.aged-sea-ee35.workers.dev/health
curl -fsSL https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.json | jq .

# Staging
curl -fsSL https://primo.evomap.ai/health
curl -fsSL https://primo.evomap.ai/channel-plugin/latest.json | jq .

# 防御回归：恶意路径必须 400
curl -i "https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/../../../etc/passwd"
# 期望: HTTP/1.1 400 Bad Request
```

---

## 4. Cheatsheet — 文件、配置、workflow 索引

### 4.1 Workflows

| 文件 | 触发 | 干什么 |
|---|---|---|
| `.github/workflows/publish-channel-plugin.yml` | push 到 `main` 改 `connector/channel-plugin/**` 或打 `channel-plugin-v*` tag | 跑测试 + 上传 R2 + 创 GitHub Release。**npm publish step 已注释**（§6） |
| `.github/workflows/publish-connectors.yml` | push 到 `main` 改 `connector/**`（除 channel-plugin） | sync 到 `Neon-Wang/xiachong-relay-connect` + R2 上传 `evopaimo-connect.py`。**npm publish step 已注释**（§6） |
| `.github/workflows/deploy-workers.yml` | push 改 `workers/**` / `avatar-gen-server/**` 或打 `workers-v*` tag | typecheck + test；main push 自动 deploy staging，`workers-v*` tag 或手动 workflow_dispatch 才 deploy production |

### 4.2 关键代码 / 配置文件

| 文件 | 角色 |
|---|---|
| `connector/channel-plugin/package.json` | 包名 `@evopaimo/channel`、版本号、`bin`/`exports`、`files`（决定 tarball 内容） |
| `connector/channel-plugin/openclaw.plugin.json` | OpenClaw plugin manifest（id `evopaimo`、`configSchema`） |
| `connector/channel-plugin/src/config.ts` | `validateRelayUrlScheme` — 强制 `https://` 的关卡 |
| `connector/channel-plugin/src/protocol.ts` | wire 协议 schema + sanitizers + 长度上限（`MAX_PROMPTS=32`、`MAX_PROMPT_LEN=32KB` 等） |
| `connector/channel-plugin/src/runtime/account-runtime.ts` | per-account 主循环；`startAccount` 必须返回长 promise（resolve 早 = gateway 无限重启） |
| `connector/channel-plugin/src/runtime/pairing.ts` | `/api/link` + `/api/agent-auth` HTTP 握手；首次 link → 持久化 `agent_token` |
| `connector/channel-plugin/src/runtime/ws-client.ts` | WebSocket 生命周期（重连 + 反应式 pong） |
| `workers/src/api/channel-plugin.ts` | Workers 端的 `/channel-plugin/*` 路由（含 `SAFE_VERSION` 正则防路径遍历） |
| `workers/src/router.ts` | 主路由表，挂上 `channelPluginRoutes` |
| `workers/wrangler.toml` | Workers 多环境配置（dev/staging/production R2 bucket 名、account_id 等） |
| `workers/test/env.d.ts` | **vitest pool-workers 的类型声明**——`CONNECTOR_BUCKET` / `GEN_BUCKET` 必须在这里 declare（否则 typecheck 失败） |

### 4.3 R2 bucket 命名约定（生产 + staging 一一对应）

| Bucket | 用途 | 路径前缀 |
|---|---|---|
| `xiachong-connector-prod` | 生产环境 channel plugin + connector 脚本 | `channel-plugin/`、`connector/` |
| `xiachong-connector-staging` | Staging 环境同上 | `channel-plugin/`、`connector/` |
| `xiachong-gen-prod` / `-staging` | Avatar 生成产物（`.evopaimo` 加密包） | `gen/` |
| `xiachong-bucket` / `xiachong-bucket-staging` | 通用资源 | — |

> **千万不要**手动在错误账号 (`9e17cd2512fe5dc7aa8bd8b09ed250e9`) 下创建同名 bucket——2026-04-22 因 wrangler 用了错账号自动建出 `xiachong-migrations-staging`/`-gen-staging`/`-connector-staging` 三个空 bucket，要手动 `wrangler r2 bucket delete` 清理。

### 4.4 Cloudflare DNS / Custom Domain

| 域名 | 指向 |
|---|---|
| `xiachong-api.aged-sea-ee35.workers.dev` | Workers 默认域，**生产环境唯一对外入口** |
| `xiachong-api-staging.aged-sea-ee35.workers.dev` | Workers 默认域，staging |
| `primo.evomap.ai` | Custom domain → staging Workers（dev/联调用） |

> 客户端 `client/.env.development` 永远指 `primo.evomap.ai`（staging）。客户端生产 build 走 `xiachong-api.aged-sea-ee35.workers.dev`。

---

## 5. 适配事项总览（必读）

> 这些是历史踩过的坑、不写明白下次有 99% 概率再踩一遍的约束。按重要性排序。

### 5.1 `relayUrl` 强制 `https://`（0.1.1 起）

`src/config.ts` 的 `validateRelayUrlScheme` 在 plugin 启动时拒绝任何非 `https://` 的 relayUrl：`http://`/`ws://`/`file://`/`javascript:` 等都直接抛错退出。

**为什么**：`linkCode + secret` 在第一次 `/api/link` 时会随 HTTP body 一起发，明文暴露 = 凭证立即作废 + 攻击者可以接管 OpenClaw → 让 LLM 跑任何聊天上下文。

**对接事项**：
- 任何文档示例都必须写 `https://`
- 不要为了"本地联调"在文档里放 `http://localhost:8787`——staging 已经是 https，没有理由开 http 路径
- 如果未来要支持 self-host relay，必须强制要求用户用 valid TLS（Let's Encrypt 即可），不要给"prod 用 https，dev 用 http"的开关

### 5.2 `openclaw.json` 必须显式写 `"allowFrom": ["*"]`

不写会让 `openclaw security audit` 报 CRITICAL `channels.evopaimo.dm.open`。

**为什么**：OpenClaw audit 工具只看 JSON 文件、不看 plugin 实际行为。Plugin runtime 默认就接受所有来源（因为真正的鉴权门是 relay 的 `linkCode + secret` 配对），但 audit 不知道这一点。

**对接事项**：
- INSTALL.md / README 模板都已经写好这一行，不要轻易删
- 如果未来改 audit 行为或 OpenClaw 升级，复测 `openclaw security audit --deep` 是否还报这一条
- 用户如果手动改了 audit 配置嫌烦，要劝他不要——这是字段级容忍度，没有 runtime 副作用

### 5.3 `startAccount` 返回的 promise 必须长期 pending

`src/runtime/account-runtime.ts` 中的 `startAccount(ctx)` 必须返回一个 **直到 `stopAccount` 被调才 resolve** 的 promise。

**为什么**：OpenClaw gateway 把"promise resolve"解读为"账号正常退出"，会触发 `auto-restart attempt N/10` 退避循环。

**对接事项**：
- 改 `account-runtime.ts` 时务必跑 `pnpm test` —— `account-runtime.test.ts` 有 donePromise 契约测试
- 看到日志反复出现 `[default] auto-restart attempt N/10` = 这个契约被破坏了，先去看最近 commit
- 不要"为了简洁" return 一个 helper 函数返回值——必须是 explicit 的 `await new Promise<void>(...)`

### 5.4 0.1.0 → 0.1.1 重装陷阱

如果用户先装了 0.1.0 preview，又把 `~/.openclaw/extensions/evopaimo/` 手动删了（但 `openclaw.json` 还留 `channels.evopaimo`），下次 `openclaw plugins install` 会失败：

```text
Invalid config: channels.evopaimo: unknown channel id: evopaimo
```

**为什么**：OpenClaw `plugins install` 在写新 plugin 文件**之前**先做配置校验。配置里引用了 `evopaimo` 但插件目录已经被删，校验过不去。

**处置**：先临时移除 `channels.evopaimo`、装完再加回来。完整脚本见 [`README.md › Re-install gotcha`](./connector-channel-plugin-README.md#re-install-gotcha)。

### 5.5 `agent_token` 持久化位置（升级要兼容）

| 版本 | 位置 |
|---|---|
| 0.1.0 preview | `~/.openclaw/extensions/evopaimo/state-<account>.json` |
| 0.1.1+ | `~/.openclaw/channels/evopaimo/state-<account>.json`（mode 0600） |

`src/runtime/pairing.ts` 在第一次读取时会自动从 0.1.0 路径迁移到 0.1.1 路径，旧文件留在原地（变成 no-op）。

**对接事项**：
- 改持久化路径 = breaking change，必须 bump major
- 新增字段时必须保证老 `agent_token` 仍可解读（pairing.ts 用 try/catch 包了 fallback 到 link 流程）
- 不要在 plugin 升级时清空 `~/.openclaw/channels/evopaimo/`——会强制所有用户重新配对

### 5.6 Workers `SAFE_VERSION` 正则不可放宽

`workers/src/api/channel-plugin.ts` 用 `/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/` 校验路径里的版本号。

**为什么**：R2 接受任意 key 名，如果让 `/channel-plugin/<arbitrary>.tgz` 直接代理到 R2，攻击者可以构造 `..` / 绝对路径试探整个 bucket。

**对接事项**：
- 改这个正则**只能更严**不能更松
- 如果未来要支持 prerelease（比如 `v0.1.2-rc.1`），现在的正则已经覆盖，不需要改
- 必须保留 `400 Bad Request` 而非 404 —— 让攻击者能区分两者就给了他遍历 bucket 的信号

### 5.7 CI: 用 `pnpm dlx` 不要用 `npx --yes`

GitHub Actions runner 上，`pnpm/action-setup@v4` 设置的 `PNPM_HOME` 会干扰 `npx` 找二进制（`sh: 1: wrangler: not found`，exit 127）。

**为什么**：`PNPM_HOME` 注入到 PATH 前面，`npx --yes wrangler@4` 装下来的 wrangler 二进制不在 `PNPM_HOME` 而在 npm 全局目录，PATH 顺序使 `which wrangler` 找不到。

**对接事项**：
- 任何在 GitHub Actions 里要跑 wrangler / 其他 npm 全局工具的地方，**永远用 `pnpm dlx`**
- 两个 workflow 都已修，搜 `pnpm dlx wrangler` 看模式
- 本地脚本不受影响，本地用 npx 是 OK 的（PATH 干净）

### 5.8 `workers/test/env.d.ts` 需声明所有 R2 binding

`@cloudflare/vitest-pool-workers` 的测试环境 `Env` 类型独立于 `workers/src/env.d.ts`。新加 R2 binding 时**两个文件都要改**。

**为什么**：测试环境的 `c.env.CONNECTOR_BUCKET` 类型来自 `workers/test/env.d.ts`，不声明 = `TS2339: Property 'CONNECTOR_BUCKET' does not exist on type 'Env'`，CI typecheck 失败。

**对接事项**：
- 加新 binding：**同时**改 `workers/src/env.d.ts` 和 `workers/test/env.d.ts`
- 跑 `pnpm typecheck` 验证（这一步 2026-04-22 修过一次，看 git log `workers/test/env.d.ts`）

### 5.9 Cloudflare Account ID 不要弄错

工作账号是 **`7a3d6232d52a3cb9123ceee7e5538edf`**（Admin@autogame.ai）。

`9e17cd2512fe5dc7aa8bd8b09ed250e9` 是 Bigdangg@gmail.com 个人账号——曾经 wrangler 默认登进去过，导致：
- `wrangler r2 object put` 在错账号自动创建空 bucket
- `wrangler deploy` 报 `KV namespace not found`（因为 namespace ID 在另一个账号）

**对接事项**：
- 本地部署务必 `export CLOUDFLARE_ACCOUNT_ID=7a3d6232d52a3cb9123ceee7e5538edf`
- 第一次部署前先 `wrangler whoami` 确认账号
- 看到 R2 / KV / D1 报"not found"先排查账号

### 5.10 Staging 与 Prod URL 不可混

- 客户端 `client/.env.development` 写死 `https://primo.evomap.ai`，**永不改**
- 客户端生产 build 写 `https://xiachong-api.aged-sea-ee35.workers.dev`
- 用户的 `openclaw.json` 应该跟着 client 用同一个 relay：客户端连 staging → openclaw 也连 staging，否则配对永远失败（凭证只在 staging Workers 的 D1 里有记录）

### 5.11 Inbound 协议长度上限（DoS 防御）

`src/protocol.ts` 强制：

| 字段 | 上限 |
|---|---|
| `init_request.prompts.length` | 32 条 |
| 每条 prompt / expect | 32 KB |
| `message.content` | 50 KB |
| `agent_id` 字符集 | `^[A-Za-z0-9_.\-]+$`，长度 ≤ 64 |

**对接事项**：
- Workers 端在 `workers/src/relay/` 也要镜像同一组限制（CDN 边缘 50KB 已设）
- 改这些数字时务必 review attack-sim.mjs 里的对应场景
- 切勿放宽这些上限 —— 这是 plugin 唯一能信任 relay 的边界

### 5.12 emotionWrapper 的兼容性

`emotionWrapperEnabled: true`（默认）会给用户消息外加一层 `EMOTION_PROMPT` JSON envelope，要求 LLM 返回 `{emotion, full_text, tts_text}` 严格 JSON。

**对接事项**：
- 客户端依赖 `emotion` 字段渲染表情，关闭这个 wrapper 等于让客户端永远显示中性表情
- 如果用户 host agent 已经包了情绪 prompt，再叠一层会让 LLM 困惑、概率性返回非 JSON → plugin 走 `parseEmotion` fallback，但 `tts_text` 会丢
- 修改 `emotion.ts` 的 fallback 逻辑必须跑 `pnpm test`，`emotion.test.ts` 覆盖了 6 类异常输入

---

## 6. npm 通道重启清单

> **判断条件**：什么时候应该启用 npm？
>
> 当且仅当出现以下场景之一：
> 1. 有多个外部团队反馈 `openclaw plugins install @evopaimo/channel` 是他们流程的硬依赖（curl + tarball 流程不接受）
> 2. 我们要用 `npx evopaimo-channel-attack-sim` 这类 npm bin 当公开诊断工具
> 3. OpenClaw 主线把 npm package name 当成 plugin discovery 的唯一标识符
>
> 不满足以上任一 = 暂时不开。R2 + GitHub Release 已经覆盖国内外所有用户分发场景。

### 6.1 准备工作（重启前一次性）

| 责任人 | 做什么 | 输出 |
|---|---|---|
| 持有 `@evopaimo` npm scope 的同事 | 在 npm 网站确认 scope 还在自己名下、2FA 已开 | `npm whoami` 输出账号名，`npm access ls-packages` 看到 `@evopaimo/*` |
| 仓库 admin（Neon Wang） | 准备 npm Trusted Publishing 绑定参数 | publisher: GitHub Actions / org: EvoMap / repo: XiaChong / workflow: `publish-channel-plugin.yml` |

### 6.2 反向打开 workflow 注释

```bash
# 1) Channel plugin
vim .github/workflows/publish-channel-plugin.yml
#    在 §"PENDING: npm publish disabled..." 块下面把:
#    - "Check if version needs publishing to npm" step 反注释
#    - "Publish to npm (Trusted Publishing)" step 反注释
#    - Summarize 中的 "npm publish: PENDING" 那行改回原来的 if/else 分支
#    顶部 banner 注释整段删除（或改成历史说明）
#
#    搜 keyword "PENDING: npm publish" 一次性定位

# 2) Connector
vim .github/workflows/publish-connectors.yml
#    在 §"PENDING: npm publish..." 块下面把 "Publish connector to npm" step 反注释
#    顶部 banner 同上
```

### 6.3 首次 manual publish

按 `connector/channel-plugin/PUBLISHING.md` §2（已加 ⚠️ banner，但内容仍是正确的步骤）操作：

```bash
git clone https://github.com/EvoMap/XiaChong.git
cd XiaChong/connector/channel-plugin
pnpm install
pnpm ci
pnpm pack --dry-run   # 检查 tarball 内容
npm login              # 持有 @evopaimo scope 的账号
npm publish --access public
```

`evopaimo-relay-connect` 同理（在 `connector/` 目录跑），按 `connector/NPM_ONBOARDING.md` 操作。

### 6.4 绑定 Trusted Publishing

到 https://www.npmjs.com/package/@evopaimo/channel → Settings → Trusted Publishing：

| 字段 | 值 |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `EvoMap` |
| Repository | `XiaChong` |
| Workflow filename | `publish-channel-plugin.yml` |
| Environment | (留空) |

`evopaimo-relay-connect` 同理，workflow filename 填 `publish-connectors.yml`。

### 6.5 验证 CI 接管

```bash
# 改 channel-plugin 任意小文件 + bump 版本 + push
cd connector/channel-plugin
echo "// touched" >> CHANGELOG.md
pnpm version patch    # 比如 0.1.1 → 0.1.2
git add . && git commit -m "test: verify npm Trusted Publishing"
git push origin main
git tag channel-plugin-v0.1.2 && git push origin channel-plugin-v0.1.2

# CI 应该跑过 npm publish step 且不报 401/403
gh run watch --workflow="Publish Channel Plugin"

# 验证 npm 上有了
npm view @evopaimo/channel version    # 期望: 0.1.2
```

### 6.6 同步更新文档

回滚以下文档中的"PENDING"说明：

- [ ] `connector/channel-plugin/INSTALL.md` §"渠道 C — npm" → 恢复成可执行说明
- [ ] `connector/channel-plugin/INSTALL.md` 三渠道表格 → 恢复 npm 行
- [ ] `connector/channel-plugin/README.md` Status 表 M6b → ✅
- [ ] `connector/channel-plugin/README.md` Install 表格 → 恢复 npm 行 + 命令
- [ ] `connector/channel-plugin/README.md` Verify it yourself 段 → 恢复 `npx -p @evopaimo/channel evopaimo-channel-attack-sim`
- [ ] `connector/channel-plugin/PUBLISHING.md` 顶部 banner → 删除
- [ ] `connector/RELEASE.md` 顶部 banner → 删除
- [ ] `connector/NPM_ONBOARDING.md` 顶部 banner → 删除
- [ ] `connector/README.md` "两种模式"表格 + npm 状态说明 → 恢复
- [ ] 本文（HANDOVER.md）—— 把这一节标 ✅ 已重启，把状态总览的 PENDING 行删掉

---

## 7. 故障速查

### 7.1 用户拉 R2 latest.tgz 拿到空文件 / 旧文件

| 排查 | 处置 |
|---|---|
| `curl -fI https://xiachong-api.../channel-plugin/latest.tgz` 看 `etag` | 和 `latest.json.sha256` 对比 |
| 如果 `latest.tgz` 是空 → CI 上传时 race condition | 重跑 `Publish Channel Plugin` workflow |
| 如果 `latest.tgz` 落后 → CDN 缓存 5 分钟未过 | 等，或在 Cloudflare 控制台 purge `/channel-plugin/latest.*` |

### 7.2 sha256 校验不过

| 可能 | 处置 |
|---|---|
| 下载中途断了 | 加 `-f` 重下；用 `curl -C -` 续传 |
| CDN 中间节点污染 | 换另一条腿（A ↔ B）重下，对比 sha |
| `latest.tgz` 和 `latest.sha256` 来自不同发布（race） | `curl latest.json | jq .sha256` 拿权威值 |
| **真的被替换了**（罕见） | 立即 `security@evomap.ai`，不要装 |

### 7.3 `openclaw plugins install` 失败：`Invalid config: channels.evopaimo: unknown channel id`

[§5.4](#54-010--011-重装陷阱) 经典陷阱。处置脚本：[`README.md › Re-install gotcha`](./connector-channel-plugin-README.md#re-install-gotcha)。

### 7.4 启动直接退出 + `relayUrl must use https://`

`openclaw.json` 里 `relayUrl` 写成了 `http://`。改成 `https://...` 即可。详见 [§5.1](#51-relayurl-强制-https-011-起)。

### 7.5 反复 `auto-restart attempt N/10`

`startAccount` 提前 resolve 了。Plugin 内部 bug。

```bash
# 收集证据
journalctl --user -u openclaw-gateway -n 200 | grep evopaimo > /tmp/log.txt
# 看是哪一轮 auto-restart 之前最后一行 plugin log 是什么
# 报 issue 时附 log + plugin version + OpenClaw version
```

[§5.3](#53-startaccount-返回的-promise-必须长期-pending) 是契约。

### 7.6 `failed to pair: 401`

| 原因 | 处置 |
|---|---|
| 客户端那边重新生成了 linkCode | 用新凭证、删 `~/.openclaw/channels/evopaimo/state-default.json` 强制重 link |
| `secret` 复制丢字符 | 重抄一遍，要 64 位 hex 完整无空格 |
| 时钟偏差 | `chronyd` / `timedatectl` 校准 |
| **客户端连了 staging，OpenClaw 配的 prod relayUrl** | 改 `openclaw.json` 让两边对齐 |

### 7.7 WebSocket 连上立刻断

| 原因 | 处置 |
|---|---|
| 公司防火墙 / 路由器 / 透明代理拦 WebSocket upgrade | `curl -fI https://xiachong-api.../health` 测 HTTPS 通；用手机热点对比 |
| Workers 那边 token 失效 | 看响应 401/403；走 7.6 流程 |
| 客户端没在线 | 这是预期，relay 接连接但不推消息 = 正常静默 |

### 7.8 CI 报 `wrangler: not found`

[§5.7](#57-ci-用-pnpm-dlx-不要用-npx---yes)。把 `npx --yes wrangler@4` 全改 `pnpm dlx wrangler@4`。

### 7.9 CI typecheck 报 `Property 'CONNECTOR_BUCKET' does not exist on type 'Env'`

[§5.8](#58-workerstestenvdts-需声明所有-r2-binding)。同时改 `workers/src/env.d.ts` 和 `workers/test/env.d.ts`。

### 7.10 `wrangler r2 bucket create` 在错账号里建了空 bucket

[§5.9](#59-cloudflare-account-id-不要弄错)。

```bash
# 删掉
CLOUDFLARE_ACCOUNT_ID=9e17cd2512fe5dc7aa8bd8b09ed250e9 wrangler r2 bucket delete <name>
# 用对账号重做
export CLOUDFLARE_ACCOUNT_ID=7a3d6232d52a3cb9123ceee7e5538edf
```

---

## 8. 责任划分 / 联系人

| 职责 | 谁 | 备注 |
|---|---|---|
| 长期 maintainer（写代码 + 发版） | Neon Wang | 主线开发 |
| Cloudflare 账号管理（账号 `7a3d6232d52a3cb9123ceee7e5538edf`） | Neon Wang | 加人/换 token 找 ta |
| `@evopaimo` npm scope 持有 | （PENDING 状态下无人) | 重启 npm 通道时再确定 |
| 安全问题上报 | `security@evomap.ai` | 不公开开 issue |
| 一般 bug / 功能请求 | https://github.com/EvoMap/XiaChong/issues | 公开 |

---

## 9. 相关文档索引

> 本文（HANDOVER.md）是入口，更细的内容散在以下文件里：

| 文档 | 用途 |
|---|---|
| [`INSTALL.md`](./INSTALL.md) | 用户视角的安装/配置/排查手册（端到端 5 分钟教程） |
| [`README.md`](./connector-channel-plugin-README.md) | 插件本身的架构、内部模块、安全模型 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 历次版本改动 |
| [`PUBLISHING.md`](./PUBLISHING.md) | 历史 npm 发版手册（**当前 PENDING 不可执行**，重启时反向打开 §6 后再读） |
| [`../README.md`](../connector-README.md) | Connector 总览（CLI 模式 vs 插件模式对比） |
| [`../RELEASE.md`](../RELEASE.md) | Connector 历史发版手册（**npm 部分 PENDING**，R2/GitHub mirror 部分仍有效） |
| [`../NPM_ONBOARDING.md`](../NPM_ONBOARDING.md) | 给一次性首发同事的 onboarding（**PENDING 不安排**） |
| [`../PERSISTENT_SETUP.md`](../PERSISTENT_SETUP.md) | CLI 模式的持久化部署（systemd / launchd） |
| [`../../docs/specs/openclaw-hooks-integration/spec-2-channel-plugin.md`](../../docs/specs/openclaw-hooks-integration/spec-2-channel-plugin.md) | Phase 2 spec：channel plugin 架构与决策原因 |
| [`../../docs/specs/openclaw-hooks-integration/plan-phase-2.md`](../../docs/specs/openclaw-hooks-integration/plan-phase-2.md) | Phase 2 实施计划（M1-M7 验收条件） |
| [`../../docs/specs/openclaw-hooks-integration/POSTMORTEM.md`](../../docs/specs/openclaw-hooks-integration/POSTMORTEM.md) | Phase 1 hooks 撤回事故复盘（解释为什么走 channel plugin 路线） |

---

_最后更新：2026-04-22_  
_本文修订请同步更新本行日期。重大改动（新加章节、调整结构）请在 git commit 中带 `docs(handover):` 前缀方便检索。_
