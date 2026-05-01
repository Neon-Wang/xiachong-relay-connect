# 安装与连接 — `@evopaimo/channel`

> **看这篇的人**：在自己的机器（Linux / macOS / Windows）上跑 OpenClaw、想接入 EvoPaimo 桌面宠物的最终用户。
>
> **不看这篇的人**：插件维护者（看 [`PUBLISHING.md`](./PUBLISHING.md)）、想了解架构与安全细节的开发者（看 [`README.md`](./connector-channel-plugin-README.md)）。

全程预计 5 分钟。如果某一步卡住，跳到本文末尾的【故障排查】。

---

## 目录

1. [它是什么、为什么这样分发](#0-它是什么为什么这样分发)
2. [先决条件](#1-先决条件)
3. [获取 tarball — 三条下载渠道](#2-获取-tarball--三条下载渠道)
4. [校验 sha256](#3-校验-sha256)
5. [装到 OpenClaw](#4-装到-openclaw)
6. [配置 `openclaw.json`](#5-配置-openclawjson)
7. [拿到 `linkCode` + `secret`](#6-拿到-linkcode--secret)
8. [启动并验证连通](#7-启动并验证连通)
9. [故障排查](#8-故障排查)
10. [升级与回滚](#9-升级与回滚)

---

## 0. 它是什么，为什么这样分发

`@evopaimo/channel` 是一个 OpenClaw **channel plugin**——OpenClaw 用同一套接口接 Slack / Telegram / WhatsApp 等等，我们让 EvoPaimo 客户端走的也是这一套。装上之后：

- OpenClaw 网关 → 加载这个插件 → 通过 WebSocket 连到 Cloudflare Workers 中继 → 你的 EvoPaimo 桌面客户端（Electron）
- 不需要再单独跑 `evopaimo-connect.py` 这个 Python CLI 了

我们当前有 **两条互为镜像** 的下载渠道（**npm 通道暂未启用**）：

| 渠道 | URL 起点 | 适合谁 | 备注 |
|---|---|---|---|
| **A. GitHub Release** | `https://github.com/EvoMap/XiaChong/releases` | 想要权威源 + 历史所有版本的人 | 每个 tag 一个 release，永不变更 |
| **B. 官方 R2 镜像** | `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/` | 中国大陆 / 网络受限的用户 | 走 Cloudflare 边缘节点，国内可达 |
| ~~C. npm~~ | ~~`openclaw plugins install @evopaimo/channel`~~ | — | **PENDING**：未在 npmjs.com 注册成功，CI 中 npm publish 步骤已注释掉。状态见 [`HANDOVER.md`](./HANDOVER.md#npm-通道重启清单) |

A 与 B 在 CI 同一次构建中 **同时** 写入：tarball 字节相同、sha256 相同。两条腿任选其一，都能走完后续配置流程。

---

## 1. 先决条件

```bash
# OpenClaw 网关已装且能正常启动
openclaw --version          # 期望 ≥ 2026.4.0
openclaw plugins ls         # 不报错就行

# 如果用 GitHub Release 下载，需要 curl 或 wget；中国大陆建议直接用渠道 B
curl --version
shasum --version            # macOS/Linux 自带；Windows 用 `Get-FileHash` 替代
```

如果 `openclaw --version` 命令找不到，先按 OpenClaw 官方文档把网关装好；本插件不会自动给你装 OpenClaw。

---

## 2. 获取 tarball — 三条下载渠道

### 渠道 A — GitHub Release（推荐验证用）

```bash
VERSION="0.1.1"   # ← 替换为你想装的版本，列表见 https://github.com/EvoMap/XiaChong/releases
curl -fL -o evopaimo-channel.tgz \
  "https://github.com/EvoMap/XiaChong/releases/download/channel-plugin-v${VERSION}/evopaimo-channel-${VERSION}.tgz"
curl -fL -o latest.sha256 \
  "https://github.com/EvoMap/XiaChong/releases/download/channel-plugin-v${VERSION}/latest.sha256"
```

每个 release 同时附带：
- `evopaimo-channel-<version>.tgz` — tarball 本体
- `latest.sha256` — `<sha256>  evopaimo-channel-<version>.tgz` 一行
- `latest.json` — 结构化 metadata（`name`/`version`/`size`/`releasedAt`/`gitSha`）

### 渠道 B — 官方 R2 镜像（推荐国内用户）

```bash
# 方式 1：拿最新版本
curl -fL -o evopaimo-channel.tgz \
  https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz
curl -fL -o latest.sha256 \
  https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.sha256

# 方式 2：拿指定版本（不可变，永久有效）
VERSION="0.1.1"
curl -fL -o evopaimo-channel.tgz \
  "https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/v${VERSION}.tgz"

# 方式 3：先看 metadata 再决定
curl -fsSL https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.json
# {
#   "name": "@evopaimo/channel",
#   "version": "0.1.1",
#   "tarball": "evopaimo-channel-0.1.1.tgz",
#   "sha256": "...",
#   "size": 12345,
#   "releasedAt": "2026-04-22T10:00:00Z",
#   "downloads": { ... }
# }
```

| 路径 | 缓存策略 | 可变性 |
|---|---|---|
| `/channel-plugin/latest.tgz` | `max-age=300`（5 分钟） | 每次发版变 |
| `/channel-plugin/v<semver>.tgz` | `max-age=31536000, immutable`（1 年） | **永不变** |
| `/channel-plugin/latest.sha256` | `max-age=60` | 每次发版变 |
| `/channel-plugin/latest.json` | `max-age=60` | 每次发版变 |

> Staging 镜像（用于客户端 dev 模式 + 内部测试）：把上面 URL 里的主机换成 `primo.evomap.ai`，其余路径相同。生产环境请坚持用 `xiachong-api.aged-sea-ee35.workers.dev`。

### 渠道 C — npm（**PENDING，请勿尝试**）

`@evopaimo/channel` 当前**没有**发布到 npm。在 npmjs.com 上搜不到、`npm install` 会拿到 404。

- 原因：首次发布需要持有 `@evopaimo` scope 的 npm 账号 + 2FA，目前还没安排到人。
- CI 工作流里的 npm publish 步骤已显式注释掉（避免每次构建报 404 干扰）。
- 重启时机和操作步骤：见 [`HANDOVER.md`](./HANDOVER.md#npm-通道重启清单)。
- 在那之前，**请走渠道 A 或 B**。功能上完全等价，只是手动 `curl` 一次再 `openclaw plugins install ./xxx.tgz` 而已。

---

## 3. 校验 sha256

**任何渠道**下载后都建议跑一次校验，挡住中间人 / CDN 缓存污染 / 错下旧版本三类问题。

### macOS / Linux

```bash
# 渠道 A/B 都附带 latest.sha256，格式是 shasum(1) 标准格式
shasum -a 256 -c latest.sha256
# 期望输出：
# evopaimo-channel-0.1.1.tgz: OK
```

或者手算对一下：

```bash
shasum -a 256 evopaimo-channel.tgz
# 把输出的第一段 hex 字符串和 latest.sha256 / latest.json 里的对比
```

### Windows PowerShell

```powershell
$expected = (Invoke-WebRequest "https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.sha256").Content.Split(" ")[0]
$actual   = (Get-FileHash evopaimo-channel.tgz -Algorithm SHA256).Hash.ToLower()
if ($expected -eq $actual) { "OK" } else { "MISMATCH" }
```

> sha256 不一致 = **不要装**。先去 [issue tracker](https://github.com/EvoMap/XiaChong/issues) 报问题，再决定是否换渠道重下。

---

## 4. 装到 OpenClaw

```bash
openclaw plugins install ./evopaimo-channel.tgz
```

OpenClaw CLI 会：
1. 校验 `openclaw.plugin.json` 的 `configSchema`
2. 把文件铺到 `~/.openclaw/extensions/evopaimo/`
3. 在 `~/.openclaw/openclaw.json` 的 `plugins` 段注册

如果之前装过、想强制覆盖：

```bash
openclaw plugins install --force ./evopaimo-channel.tgz
```

> ⚠️ 如果之前装过 0.1.0 preview 版又把插件文件夹手动删了，重装时可能报 `Invalid config: channels.evopaimo: unknown channel id: evopaimo`。处理办法见 [README.md › Re-install gotcha](./connector-channel-plugin-README.md#re-install-gotcha)。

---

## 5. 配置 `openclaw.json`

编辑 `~/.openclaw/openclaw.json`（如果你不放心，先 `cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak`）。

下面这段可以**直接复制粘贴**——它不仅能跑通，还能让 `openclaw security audit` 全绿。

```jsonc
{
  // 推荐显式 allowlist，杜绝意外加载第三方插件
  "plugins": {
    "allow": ["evopaimo"]
  },
  "channels": {
    "evopaimo": {
      // ── 必填 ────────────────────────────────────────────
      "relayUrl": "https://xiachong-api.aged-sea-ee35.workers.dev",
      "linkCode": "ABC123",
      "secret":   "粘贴客户端给你的 64 位 hex secret",

      // ── 选填 ────────────────────────────────────────────
      "sessionLabel": "mobile-app",
      "emotionWrapperEnabled": true,

      // ── 必加（否则 audit 会 CRITICAL 警告）────────────
      // 我们的真正鉴权门是 relay 的 linkCode + secret 配对：
      // 任何人能建立 WebSocket 会话就已经证明持有 secret。
      // 但 openclaw security audit 只看 JSON 文件，所以必须
      // 显式 allowFrom: ["*"] 才能消掉它的 CRITICAL 提示。
      "allowFrom": ["*"]
    }
  }
}
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `relayUrl` | yes | Cloudflare Workers relay URL，**必须 `https://`**（0.1.1 起强制；`http://` 会在启动时被插件直接拒绝，避免凭证以明文泄露）。生产 = `https://xiachong-api.aged-sea-ee35.workers.dev`，staging = `https://primo.evomap.ai`。 |
| `linkCode` | yes | EvoPaimo 桌面客户端 → 配对面板里的 6 位字符配对码 |
| `secret` | yes | 与 `linkCode` 一起出现的 64 位十六进制密钥；插件只在第一次 `/api/link` 时用它，之后用换出来的长效 `agent_token`，并把 `agent_token` 写在 `~/.openclaw/channels/evopaimo/state-default.json`（mode `0600`） |
| `sessionLabel` | no（默认 `mobile-app`） | 写入会话元数据，`openclaw status` 能看到 |
| `emotionWrapperEnabled` | no（默认 `true`） | 是否在用户消息外面包一层 `EMOTION_PROMPT` JSON envelope（让 LLM 直接返 `{emotion, full_text, tts_text}`）。除非你自己的 agent 已经包了，否则别关。 |
| `allowFrom` | 强烈建议 `["*"]` | OpenClaw audit 用，**与插件 runtime 行为无关**（runtime 始终接受所有来源，因为真正的关卡在 relay 的配对密钥）。不写这个字段，audit 会报 CRITICAL `channels.evopaimo.dm.open`。 |

---

## 6. 拿到 `linkCode` + `secret`

它们由 EvoPaimo 桌面客户端生成，每对凭证只对一台 OpenClaw 宿主机有效。

### 普通用户（生产构建）

1. 打开 EvoPaimo 桌面客户端
2. 进入 **设置 → 连接管理**（或菜单栏 EvoPaimo logo → "配对 OpenClaw"）
3. 点击 "生成新的配对码"
4. 把弹出的 `linkCode`（6 位）和 `secret`（64 位 hex）抄到上一步的 `openclaw.json`

> 一次配对永久有效。换 OpenClaw 宿主机 / 重装时再生成新的即可。

### 开发者（dev build）

dev 模式下 Electron 主进程会把 `linkCode + secret` 同时打到 stderr 一份，方便快速联调：

```bash
pnpm -C client electron:dev 2>&1 | grep -E '\[evopaimo\] (linkCode|secret)='
```

---

## 7. 启动并验证连通

```bash
# 重启 / 启动网关；如果用 systemd 已托管，会自动 restart
openclaw gateway start

# 看实时日志（OpenClaw CLI 没提供 tail 子命令时直接看 systemd journal）
journalctl --user -u openclaw-gateway -f
# 或 macOS：
tail -F ~/.openclaw/logs/gateway.log
```

### 期望看到的日志（按顺序出现）

```text
[evopaimo] started account default (relay=https://xiachong-api.aged-sea-ee35.workers.dev)
[evopaimo] evopaimo-ws: pairing: trying agent-auth with stored agent_token
[evopaimo] paired via agent-auth (appId=openclaw_xxxx agentId=agent_xxxx)
   # 或首次：paired via link (...)
[evopaimo] evopaimo-ws: connecting accountId=default relayUrl=…
[evopaimo] evopaimo-ws: open accountId=default
```

**绝对不应该** 看到的（看到就是有问题）：

```text
[evopaimo] [default] auto-restart attempt N/10        # 表示 startAccount 提前返回了，跳到故障排查 §8.5
[evopaimo] channels.evopaimo.relayUrl must use https://...   # relayUrl 写成 http 了
[evopaimo] failed to pair: 401                        # linkCode/secret 错或被吊销
```

### 端到端冒烟测试

1. EvoPaimo 客户端聊天框发一句"你好"
2. 期望 ~20 秒内（kimi/k2p5 中位响应）收到带情绪表情的回复
3. 网关日志应有 `[evopaimo] dispatched inbound message ...` 之类的行

---

## 8. 故障排查

### 8.1 `openclaw plugins install` 报 `Invalid config: channels.evopaimo: unknown channel id`

之前装过 0.1.0 preview 又把 `~/.openclaw/extensions/evopaimo/` 删了，但 `openclaw.json` 的 `channels.evopaimo` 还在。处理脚本见 [README.md › Re-install gotcha](./connector-channel-plugin-README.md#re-install-gotcha)。

### 8.2 启动时直接退出 + `relayUrl must use https:// scheme`

0.1.1 的安全防护：`http://` / `ws://` / `file://` 等任何非 `https://` 都会被拒绝（防止 `linkCode + secret` 在握手阶段以明文泄露）。把 `openclaw.json` 里的 `relayUrl` 改成 `https://...` 即可。

### 8.3 `failed to pair: 401`

- 客户端那边可能已经吊销了这对 `linkCode/secret`（重新生成过、或换了客户端实例）
- secret 复制时漏字符、多了空格 / 换行符
- relay 时钟严重偏差导致 JWT 验证失败（极少见）

处理：去客户端"连接管理"重新生成一对，把 `~/.openclaw/channels/evopaimo/state-default.json` 删掉强制重走 `/api/link`。

### 8.4 WebSocket 反复 connect → close → reconnect

- 网络上有透明代理（公司防火墙、某些路由器固件）拦住了 WebSocket upgrade
- relay 那一侧拒绝了你的 token（看 401/403 响应）
- 客户端没在线（relay 会接受连接但不会推消息——这是预期，不算故障）

排查命令：

```bash
# 看真实建连结果
curl -fI https://xiachong-api.aged-sea-ee35.workers.dev/health

# 看 plugin 内部日志的频率（高频重连 = 有问题）
journalctl --user -u openclaw-gateway --since "5 minutes ago" | grep evopaimo
```

### 8.5 反复 `[evopaimo] [default] auto-restart attempt N/10`

`startAccount` 提前 resolve 了 — 这是 plugin 内部 bug（不应该再出现，但留个排查点）。
临时缓解：把 `gateway.restart_backoff` 拉长；根因修复需要升插件版本。报 issue 的时候带上完整日志。

### 8.6 sha256 校验失败

不要装。可能原因：

- 下载中途连接断了（curl 没加 `-f`，结果保存了 HTML 错误页）
- 走了被污染的 CDN（换另一条渠道重下，对比是否一致）
- 上游 release 文件被替换（重大安全事件，立刻反馈到 `security@evomap.ai`）

### 8.7 `openclaw security audit` 报 `channels.evopaimo.dm.open` CRITICAL

`openclaw.json` 的 `channels.evopaimo` 段没写 `"allowFrom": ["*"]`。回到 §5 的模板补上。这不是插件本身的安全漏洞——见 [README.md › Security › Known false positive](./connector-channel-plugin-README.md#security)。

### 8.8 想跑攻击模拟自检（不必要，但可选）

```bash
# 装完插件后，对装好的 dist 跑 27 个攻击场景
EVOPAIMO_DIST=~/.openclaw/extensions/evopaimo/dist \
  node ~/.openclaw/extensions/evopaimo/scripts/attack-sim.mjs
# 期望：PASS=27/27 FAIL=0
```

> 当 npm 通道（PENDING）启用后，将额外支持 `npx -p @evopaimo/channel evopaimo-channel-attack-sim`。在那之前请用上面的本地路径跑。

---

## 9. 升级与回滚

### 升级到新版

```bash
# 渠道 B：拉最新 + 校验 + 强制重装
curl -fL -o evopaimo-channel.tgz \
  https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz
curl -fL https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.sha256 \
  | shasum -a 256 -c -
openclaw plugins install --force ./evopaimo-channel.tgz
openclaw gateway restart
```

升级不会清掉你的 `state-default.json`（agentToken 持久化），所以**不需要重新配对**。

### 回滚到指定旧版

```bash
VERSION="0.1.0"   # 想回到的版本
curl -fL -o evopaimo-channel.tgz \
  "https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/v${VERSION}.tgz"
openclaw plugins install --force ./evopaimo-channel.tgz
openclaw gateway restart
```

R2 上 `v<semver>.tgz` 是 immutable 的，回多老都行。

### 完全卸载

```bash
openclaw plugins uninstall evopaimo
# 同时清掉持久化状态（可选）
rm -rf ~/.openclaw/channels/evopaimo/
# 同时清掉 openclaw.json 里的 channels.evopaimo 段（手动编辑）
```

---

## 还有问题？

- 看 [`README.md`](./connector-channel-plugin-README.md) — 架构、安全模型、内部模块
- 看 [`CHANGELOG.md`](./CHANGELOG.md) — 历次改动
- 提 issue：https://github.com/EvoMap/XiaChong/issues
- 安全问题（unfixed CVE）：`security@evomap.ai`，**请勿** 公开开 issue
