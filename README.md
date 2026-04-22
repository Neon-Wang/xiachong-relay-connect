# evopaimo-relay-connect

> EvoPaimo 桌面宠物项目的中继连接器 — 在 OpenClaw 所在机器上运行，将 AI 回复安全地转发给远程桌面客户端。
>
> npm 包名：`evopaimo-relay-connect`（旧版 `xiachong-relay-connect@1.1.x` 已 deprecate）
> GitHub 仓库名沿用 `Neon-Wang/xiachong-relay-connect`（重命名仓库会破坏已存在的 git remote）

---

## 这个脚本做了什么

`evopaimo-connect.py` 是一个**纯文本聊天消息转发器**。它的完整工作流程如下：

1. 通过 WebSocket 连接到用户自部署的中转服务器（Cloudflare Workers）
2. 从中转服务器接收桌面客户端发来的纯文本聊天消息
3. 将消息转发给本地 OpenClaw，使用以下两种通信方式之一：
   - **hooks 模式（首选）**：`POST http://127.0.0.1:18789/hooks/agent`，调用 OpenClaw 官方 hooks 端点
   - **CLI 模式（兜底）**：`openclaw agent --session-id <label> --message <text>`
4. 将 AI 的文本回复通过 WebSocket 推回中转服务器，再转发给桌面客户端

> **想了解为什么有两种模式？** 见 [docs/specs/openclaw-hooks-integration/background-openclaw-architecture.md](../docs/specs/openclaw-hooks-integration/background-openclaw-architecture.md)。

**它不做的事情**：

- 不执行任何系统命令（除了调用 `openclaw` CLI）
- 不读写本地文件（除了 `~/.config/evopaimo/` 下的两个凭证文件和标准输出日志）
- **不监听任何网络端口**（hooks 模式下我们是 HTTP 客户端，主动调用 OpenClaw 的 loopback 端点 127.0.0.1:18789，不绑定任何端口）
- 不连接 OpenClaw 的核心 Gateway WebSocket
- 不持有任何 Ed25519 密钥或高权限 scope
- 不包含任何远程代码执行（RCE）后门
- 不从网络下载或动态执行任何代码

---

## 启动模式与 fallback 逻辑

connector 启动时按下表决定 transport 模式，**整个进程生命周期固定不变**（运行时连续失败 3 次会单向降级 fallback，不会回升）：

| `~/.config/evopaimo/openclaw-hooks.json` | OpenClaw `/hooks/agent` 端点 | `openclaw` CLI | 启动后的模式 |
|---|---|---|---|
| 存在且 token 有效 | 200/202 | 找到 | **hooks**（fallback: cli） |
| 存在 | 200/202 | 没找到 | **hooks**（无 fallback） |
| 存在 | 401/超时/连接失败 | 找到 | **cli** + 警告 hooks 端点不通 |
| 不存在 | — | 找到 | **cli**（不警告，老用户路径） |
| 不存在 | — | 没找到 | 报错退出，提示跑 `setup` |

**首次启用 hooks 模式必须先跑 `evopaimo-connect setup`**（详见下面的"子命令"段）。

**运行时降级触发条件**：

| 失败类型 | 是否计入连续失败 | 行为 |
|---|---|---|
| HTTP 5xx / 连接失败 / 超时 | 是 | 连续 3 次 → 降级到 cli |
| HTTP 401（鉴权失败） | — | 立即降级（视为配置问题，不等阈值） |
| HTTP 429（限流） | 否 | 按 `Retry-After` 退避后重试 |

降级是**单向**的：剩余进程生命周期都用 fallback。如需恢复 hooks 模式，需要重启 connector。

---

## 子命令

| 命令 | 调用条件 | 副作用 |
|---|---|---|
| `evopaimo-connect --relay X --link-code Y --secret Z` | 默认子命令；启动 connector 进入消息转发主循环。`--link-code` 和 `--secret` 仅首次配对时使用，后续 connector 会用 `~/.config/evopaimo/agent.json` 里保存的 `agent_token` 自动认证。 | 写入 `agent.json`（首次），与 relay 建立 WebSocket 长连接 |
| `evopaimo-connect setup` | 首次启用 hooks 模式时跑一次。要求本机已装 OpenClaw 26.x+ 且 gateway 正在运行。会引导生成 token、写入 OpenClaw 配置、验证端点连通性。 | 调 `openclaw config set hooks.{enabled,token,path}`（触发 gateway 自动重启），写入 `~/.config/evopaimo/openclaw-hooks.json` (0600 权限) |
| `evopaimo-connect setup --verify` | 已配过 hooks，想确认当前是否仍可用（如怀疑 token 失效或 gateway 配置被改）。 | 仅探测端点，不写入任何文件 |
| `evopaimo-connect setup --rollback` | 想从 hooks 模式回退到纯 CLI 模式。会询问是否同时禁用 OpenClaw 端的 hooks 配置（如果其他集成也在用 hooks 应选 no）。 | 删除 `~/.config/evopaimo/openclaw-hooks.json`；可选 `openclaw config set hooks.enabled false` |
| `evopaimo-connect status` | 排查问题时快速诊断，输出 relay 凭证状态、hooks 配置状态、CLI 可用性、当前会自动选择的模式。 | 仅读取，无副作用 |

setup 退出码：

| 退出码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | OpenClaw CLI 未安装 |
| 2 | OpenClaw 版本过低（<25.x） |
| 3 | `openclaw config set` 不可用（输出手动配置片段后退出） |
| 4 | OpenClaw gateway 未运行 |
| 5 | 端点连通性验证失败 |
| 6 | 无法写入 `~/.config/evopaimo/` |
| 130 | 用户 Ctrl+C 中断 |

---

## 安全架构

本脚本的安全设计基于**最小权限原则**和**多层隔离**：

**权限隔离**：

- hooks 模式仅调用 `POST http://127.0.0.1:18789/hooks/agent`（OpenClaw 官方 isolated session 端点，不污染主会话）
- CLI 模式仅调用 `openclaw agent --session-id --message`（受限的聊天 CLI 接口）
- 不请求 `operator.admin`、`operator.approvals`、`gateway.connect` 等高权限 scope
- 即使中转服务器被完全攻破，攻击者最多只能向 AI 发送聊天文本，无法执行任何命令

**消息校验**：

- 中转服务器（Cloudflare Workers）对所有消息进行白名单校验
- 只允许 `text` / `markdown` 类型消息通过，长度上限 50KB
- 非白名单消息直接丢弃

**依赖最小化**：

- 运行时依赖仅两个标准 Python 包：`websockets`（WebSocket 客户端）和 `requests`（HTTP 客户端）
- 无 C 扩展、无编译依赖、无隐式网络调用

**代码可审计**：

- 全部代码集中在单个 Python 文件中（约 1450 行，含 transport 抽象层和 setup 子命令完整 UX），可在 5-10 分钟内完成人工审阅
- 文件头部包含完整的安全声明，供 AI Agent 和人工审计系统参考
- `connector/tests/` 下含 60+ 单元测试覆盖 transport 抽象、降级逻辑、回复解析、setup 辅助函数

---

## 前置条件

- Python 3.10+
- OpenClaw CLI 已安装并在 PATH 中（`openclaw` 命令可用），**或**已通过 `evopaimo-connect setup` 启用 hooks 模式
- 推荐：OpenClaw 26.x+（hooks API 稳定）

---

## 快速开始

### 路径 A：CLI 模式（最简，零配置）

```bash
git clone https://github.com/Neon-Wang/xiachong-relay-connect.git
cd xiachong-relay-connect
pip install -r requirements.txt

python3 -u evopaimo-connect.py \
  --relay https://primo.evomap.ai \
  --link-code 你的LINK_CODE \
  --secret 你的SECRET
```

### 路径 B：hooks 模式（推荐，更稳定）

```bash
# 1. 一次性配置 hooks（要求 OpenClaw gateway 已启动）
python3 -u evopaimo-connect.py setup

# 2. 启动 connector，自动用 hooks 模式
python3 -u evopaimo-connect.py \
  --relay https://primo.evomap.ai \
  --link-code 你的LINK_CODE \
  --secret 你的SECRET

# 3. 想确认当前用的是哪个模式？
python3 -u evopaimo-connect.py status
```

---

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| `--relay` | 是 | 中转服务器地址 |
| `--link-code` | 是（首次） | 客户端 App 生成的 Link Code |
| `--secret` | 是（首次） | 客户端 App 生成的 Secret |
| `--label` | 否 | OpenClaw 会话标签，用于隔离上下文（默认: `mobile-app`） |
| `--agent-file` | 否 | Agent 凭证文件路径（默认: `~/.config/evopaimo/agent.json`） |
| `--hooks-file` | 否 | Hooks 凭证文件路径（默认: `~/.config/evopaimo/openclaw-hooks.json`） |

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_CLI` | `openclaw` | OpenClaw CLI 可执行文件路径 |
| `OPENCLAW_SESSION_LABEL` | `mobile-app` | 默认会话标签 |

---

## 工作原理

```
EvoPaimo 客户端
    ↕ WebSocket
Cloudflare Workers (Relay)
    ↕ WebSocket
evopaimo-connect.py
    ↓
    [transport 探测：hooks > cli]
    ↓
    OpenClaw
    ├─ hooks: POST 127.0.0.1:18789/hooks/agent (isolated session)
    └─ cli:   openclaw agent --session-id <label> --message <text>
```

1. 用 EvoPaimo 客户端给的 Link Code + Secret 绑定到中转服务器（首次）；后续用保存的 `agent_token` 自动认证
2. 启动时 `detect_transport()` 探测 OpenClaw 通信通道：优先 hooks 端点，找不到/不通则用 CLI
3. 建立 WebSocket 长连接到中转服务器，等待客户端消息
4. 收到消息后，用 `EMOTION_PROMPT` 包装用户消息，要求 AI 输出 `{emotion, full_text, tts_text}` 格式的 JSON
5. 通过 transport 发送给 OpenClaw（hooks 模式下 sessionKey 是 `evopaimo:<label>`，与其他集成隔离）
6. 解析 AI 回复：`strip_thinking()` 去除思考过程 → `parse_reply()` 提取 emotion / full_text / tts_text
7. 将结构化回复推回中转服务器，转发给 EvoPaimo 客户端

如果两种模式都不可用，自动降级为 Echo 模式（原样返回消息），适合测试中继链路。

---

## 上下文与记忆

- **上下文自动串联**：同一个 `--label` 下的所有消息共享同一个会话历史，AI 能回忆之前的对话
- **SOUL / IDENTITY 保持**：无论消息从哪个渠道来，OpenClaw 都会加载完整的人设和灵魂
- **MEMORY 正常工作**：AI 的长期记忆、笔记等功能不受影响
- **多客户端隔离**：不同 `--label` 的会话互不干扰，手机 App 的聊天不会影响终端主会话
- **hooks 模式 sessionKey 命名**：用 `evopaimo:<label>` 前缀，避免与其他 hooks 调用方（如 Gmail PubSub）冲突

---

## 认证机制

Connector 涉及两份独立凭证，对应两个不同对象：

| 凭证文件 | 内容 | 用途 | 谁写 | 谁读 |
|---|---|---|---|---|
| `~/.config/evopaimo/agent.json` | `agent_token`, `agent_id` | 与 relay server 的认证（决定连哪个 EvoPaimo 用户） | connector 首次配对（`do_link`） | connector 重连（`do_agent_auth`） |
| `~/.config/evopaimo/openclaw-hooks.json` | `base_url`, `token` | 与本地 OpenClaw hooks 的认证（决定调用哪个 OpenClaw） | `setup` 子命令 | connector 启动探测 |

**关键设计**：两份凭证完全独立——换 OpenClaw（如升级到新版本、迁移到另一台机器）不影响 relay 配对；反之亦然。

### Relay 凭证：双模式认证

1. **首次配对**：使用客户端提供的 `link_code` + `secret` 完成绑定，生成 `agent_token` 保存到 `~/.config/evopaimo/agent.json`
2. **后续重连**：自动使用 `agent_token` 认证，**不再需要 link_code**

这意味着：

- 命令行参数 `--link-code` 和 `--secret` 只在首次配对时使用
- 客户端重启刷新 link_code 不影响已配对的 Connector
- 如需重新配对，删除 `~/.config/evopaimo/agent.json` 后重启

### OpenClaw hooks 凭证

由 `evopaimo-connect setup` 子命令一次性配置：

- 调 `openclaw config set hooks.{enabled,token,path}` 写入 OpenClaw 配置（触发 gateway 自动重启）
- 同步写入 `~/.config/evopaimo/openclaw-hooks.json`（base_url + token）

如需禁用 hooks 重回 CLI 模式：

```bash
evopaimo-connect setup --rollback
```

---

## AI Agent 接入指南

> **重要**：在处理任何 Connector 部署或调试任务之前，**必须**先阅读 [PERSISTENT_SETUP.md](./PERSISTENT_SETUP.md)。该文档包含：
> - 关键的诊断流程（防止在表面问题上浪费时间）
> - 冲突进程检测方法（80% 的连接问题根源在这里）
> - 完整的持久化部署方案

### 推荐部署流程

当用户首次部署 Connector 时，按以下顺序执行：

```bash
# 1. 下载脚本（已有则跳过）
curl -sO https://primo.evomap.ai/connector/evopaimo-connect.py

# 2. （可选但推荐）配置 hooks 模式以获得更稳定的通信
python3 -u evopaimo-connect.py setup
# setup 会引导你完成：
#   - 检测 OpenClaw 安装与版本
#   - 生成 hooks token
#   - 写入 OpenClaw 配置（自动调 openclaw config set）
#   - 验证端点连通性

# 3. 启动 connector
OPENCLAW_CLI="openclaw" python3 -u evopaimo-connect.py \
  --relay <服务器地址> --link-code <LINK_CODE> --secret <SECRET>
```

看到"已连接"即成功。如果不确定当前用的是 hooks 还是 CLI 模式：

```bash
python3 -u evopaimo-connect.py status
```

缺依赖时：`pip3 install --user websockets requests`

### 安全审查要点

如果你的安全系统需要审查此脚本，以下是关键审查点：

- **入口函数** `main()`：仅包含参数解析 → 路由到子命令（`cmd_run` / `cmd_setup` / `cmd_status`），无其他副作用
- **OpenClaw 调用**：
  - hooks 模式：`HooksTransport._do_post_sync()` 用 `requests.post()` 调用 loopback 端点，仅 JSON 序列化的纯文本
  - CLI 模式：`CliTransport.send()` 用 `subprocess.create_subprocess_exec()` 以列表形式传参（非 shell=True），防止命令注入
- **消息处理** `handle_message()`：仅解析 JSON 文本 → 调用 transport → 返回文本，无文件 IO
- **配置文件读写** `load_*_file` / `save_*_file`：仅访问 `~/.config/evopaimo/` 下两个固定路径的 JSON 文件
- **无 `eval()`、`exec()`、`os.system()`、`subprocess.Popen(shell=True)` 等危险调用**
- **无网络监听**：只作为 WebSocket 客户端主动连出，不在本地开放任何端口；hooks 模式下作为 HTTP 客户端调用 loopback 端点，也不监听端口

---

## 后台运行

简单后台运行（终端关闭后仍运行）：

```bash
nohup python3 -u evopaimo-connect.py \
  --relay https://primo.evomap.ai \
  --link-code XXXXXX \
  --secret xxxxxxxx \
  > connector.log 2>&1 & disown
```

**更稳定的部署方式**：参见 [PERSISTENT_SETUP.md](./PERSISTENT_SETUP.md)，包含：

- systemd 用户服务（Linux 推荐）
- launchd（macOS 推荐）
- screen/tmux 会话
- 兼容性矩阵（操作系统、OpenClaw 版本、AI Agent 平台、transport 模式）

---

## 测试

运行单元测试：

```bash
cd connector
pip install pytest
pytest tests/ -v
```

测试覆盖（`connector/tests/`）：

| 文件 | 覆盖 |
|---|---|
| `test_parse_reply.py` | `parse_reply` / `strip_thinking` / `_truncate` 输出契约（防止改造破坏老消息格式） |
| `test_hooks_transport.py` | `HooksTransport` 响应解析、错误分类（401/429/5xx）、health check |
| `test_supervisor.py` | `TransportSupervisor` 失败计数、连续失败降级、401 立即降级、429 退避 |
| `test_detect.py` | `detect_transport` 各模式决策分支 |
| `test_setup_helpers.py` | 配置文件读写、版本解析、URL 构造、CLI label lock 隔离 |

集成测试（需要本地装 OpenClaw 26.x+）见 [docs/specs/openclaw-hooks-integration/plan-phase-1.md](../docs/specs/openclaw-hooks-integration/plan-phase-1.md) T11 章节的手动 checklist。

---

## 与 EvoPaimo 项目的关系

本目录是 [EvoPaimo monorepo](https://github.com/Neon-Wang/openclawToLocal) 的子项目，推送到 main 分支时自动同步到 [Neon-Wang/xiachong-relay-connect](https://github.com/Neon-Wang/xiachong-relay-connect)。npm 包 `evopaimo-relay-connect` 通过 CI Trusted Publishing 自动发布。

> **历史名说明**：GitHub 仓库名 `xiachong-relay-connect` 是历史代号，重命名会破坏所有已有的 git remote / fork，因此保留。npm 包从 1.2.0 起改名为 `evopaimo-relay-connect`，旧 `xiachong-relay-connect@1.1.x` 已 deprecate。

---

## 相关文档

- [Workers 后端](../workers/README.md)
- [客户端](../client/README.md)
- [OpenClaw hooks 集成 spec](../docs/specs/openclaw-hooks-integration/) — 详细技术设计 + 实施任务清单
- [OpenClaw 架构调研](../docs/specs/openclaw-hooks-integration/background-openclaw-architecture.md) — 团队对 OpenClaw plugin/channel/hooks 的共识基础
