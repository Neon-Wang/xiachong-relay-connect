# XiaChong Connector 持久化部署 Skill

> **AI Agent 必读警告**
> 
> 当用户报告 Connector 连接失败时，你**必须**按照本文档"常见问题排查"章节的顺序执行诊断，**不得跳过任何步骤**。
> 
> **最常见的错误**：只检查配置文件格式、只看报错信息，而忽略"是否有其他进程在竞争连接"。这会导致你在表面问题上浪费大量时间。
> 
> **正确的诊断顺序**：
> 1. 检查冲突进程（systemd 服务、screen、旧进程）← 80% 的问题在这里
> 2. 检查凭证状态（agent.json 是否存在/有效）
> 3. 检查日志错误信息
> 4. 检查网络连通性
> 
> 直接跳到"重新配对"而不先排查冲突进程 = 浪费时间。

---

本文档供 AI Agent（OpenClaw/Kimi Claw 等）参考，用于在用户机器上稳定运行 XiaChong Relay Connector。

**核心问题**：Connector 是长期运行的 WebSocket 守护进程，不能用 `timeout` 或短 `yieldMs` 启动，否则会在 AI session 结束时被终止。

---

## 认证机制说明（重要）

Connector 支持**双模式认证**，理解这一点对于正确部署至关重要：

**首次配对流程**：
1. 客户端显示 `link_code` + `secret`
2. Connector 用 `link_code` + `secret` 调用 `/api/link` 完成配对
3. 配对成功后，Connector 生成 `agent_token` 并保存到 `~/.config/xiachong/agent.json`

**后续重连流程**：
1. Connector 检测到 `~/.config/xiachong/agent.json` 存在
2. 使用 `agent_token` 调用 `/api/agent-auth` 直接认证
3. **不再需要 `link_code` 和 `secret`**

**这意味着**：
- 命令行中的 `--link-code` 和 `--secret` 参数**只在首次配对时有效**
- 一旦配对成功，即使客户端重启刷新了 `link_code`，Connector 依然可以正常连接
- 如果需要重新配对（换绑），需要先删除 `~/.config/xiachong/agent.json`

**agent.json 文件位置**：
```bash
# 默认路径
~/.config/xiachong/agent.json

# 可通过 --agent-file 参数自定义
python3 xiachong-connect.py --agent-file /path/to/agent.json ...
```

**重新配对（换绑）**：
```bash
# 删除旧凭证
rm -f ~/.config/xiachong/agent.json

# 用新的 link-code 和 secret 重新启动
python3 xiachong-connect.py --relay ... --link-code NEW_CODE --secret NEW_SECRET
```

---

## 第一步：环境检测

执行以下命令收集环境信息：

```bash
# 操作系统
uname -s

# Linux 发行版（如适用）
cat /etc/os-release 2>/dev/null | grep -E "^ID=|^VERSION_ID=" || echo "non-linux"

# 可用的持久化工具
which systemctl 2>/dev/null && echo "HAS_SYSTEMD"
which launchctl 2>/dev/null && echo "HAS_LAUNCHD"
which screen 2>/dev/null && echo "HAS_SCREEN"
which tmux 2>/dev/null && echo "HAS_TMUX"
which nohup 2>/dev/null && echo "HAS_NOHUP"

# Python 路径
which python3

# OpenClaw CLI 路径
which openclaw 2>/dev/null || ls ~/.npm-global/bin/openclaw 2>/dev/null || ls /usr/local/bin/openclaw 2>/dev/null || echo "OPENCLAW_NOT_IN_PATH"

# 当前用户
whoami

# 是否有 sudo
sudo -n true 2>/dev/null && echo "HAS_SUDO" || echo "NO_SUDO"
```

---

## 第二步：根据环境选择方案

### 方案优先级

1. **systemd 用户服务** - Linux 首选，自动重启、开机启动
2. **launchd** - macOS 首选
3. **screen/tmux** - 通用备选，需要手动管理
4. **nohup + disown** - 最基础，所有 Unix 系统可用

---

## 方案 A：systemd 用户服务（Linux）

**适用条件**：
- `uname -s` 返回 `Linux`
- `which systemctl` 有输出
- 用户有 home 目录写权限

**部署步骤**：

```bash
# 1. 创建目录
mkdir -p ~/.config/systemd/user

# 2. 创建服务文件
cat > ~/.config/systemd/user/xiachong-connector.service << 'EOF'
[Unit]
Description=XiaChong Relay Connector
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=OPENCLAW_CLI=__OPENCLAW_PATH__
WorkingDirectory=__WORKDIR__
ExecStart=/usr/bin/python3 -u xiachong-connect.py --relay __RELAY_URL__ --link-code __LINK_CODE__ --secret __SECRET__
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

# 3. 替换占位符（AI 需要用实际值替换）
# __OPENCLAW_PATH__ = openclaw 的完整路径
# __WORKDIR__ = xiachong-connect.py 所在目录
# __RELAY_URL__ = 中转服务器地址
# __LINK_CODE__ = 绑定码
# __SECRET__ = 密钥

# 4. 启用并启动
systemctl --user daemon-reload
systemctl --user enable xiachong-connector
systemctl --user start xiachong-connector

# 5. 让用户服务在登出后继续运行（需要一次）
loginctl enable-linger $(whoami)

# 6. 验证
systemctl --user status xiachong-connector
journalctl --user -u xiachong-connector -n 20
```

**管理命令**：
```bash
# 查看状态
systemctl --user status xiachong-connector

# 查看日志
journalctl --user -u xiachong-connector -f

# 重启
systemctl --user restart xiachong-connector

# 停止
systemctl --user stop xiachong-connector

# 禁用开机启动
systemctl --user disable xiachong-connector
```

---

## 方案 B：launchd（macOS）

**适用条件**：
- `uname -s` 返回 `Darwin`

**部署步骤**：

```bash
# 1. 创建 plist 文件
cat > ~/Library/LaunchAgents/ai.xiachong.connector.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.xiachong.connector</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>-u</string>
        <string>__WORKDIR__/xiachong-connect.py</string>
        <string>--relay</string>
        <string>__RELAY_URL__</string>
        <string>--link-code</string>
        <string>__LINK_CODE__</string>
        <string>--secret</string>
        <string>__SECRET__</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>OPENCLAW_CLI</key>
        <string>__OPENCLAW_PATH__</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>__WORKDIR__</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>__WORKDIR__/xiachong.log</string>
    <key>StandardErrorPath</key>
    <string>__WORKDIR__/xiachong.err</string>
</dict>
</plist>
EOF

# 2. 替换占位符后加载
launchctl load ~/Library/LaunchAgents/ai.xiachong.connector.plist

# 3. 验证
launchctl list | grep xiachong
tail -20 __WORKDIR__/xiachong.log
```

**管理命令**：
```bash
# 停止
launchctl unload ~/Library/LaunchAgents/ai.xiachong.connector.plist

# 启动
launchctl load ~/Library/LaunchAgents/ai.xiachong.connector.plist

# 查看日志
tail -f __WORKDIR__/xiachong.log
```

---

## 方案 C：screen 会话

**适用条件**：
- `which screen` 有输出
- 无法使用 systemd/launchd

**部署步骤**：

```bash
# 1. 先清理可能存在的旧进程
pkill -f "xiachong-connect.py" 2>/dev/null || true
screen -S xiachong -X quit 2>/dev/null || true

# 2. 在 screen 中启动
screen -dmS xiachong bash -c 'cd __WORKDIR__ && OPENCLAW_CLI=__OPENCLAW_PATH__ python3 -u xiachong-connect.py --relay __RELAY_URL__ --link-code __LINK_CODE__ --secret __SECRET__ 2>&1 | tee xiachong.log'

# 3. 验证
sleep 3
screen -list | grep xiachong
tail -20 __WORKDIR__/xiachong.log
```

**管理命令**：
```bash
# 进入 screen 查看实时输出
screen -r xiachong

# 退出 screen（不终止进程）：按 Ctrl+A 然后按 D

# 终止
screen -S xiachong -X quit
```

**注意**：screen 会话在系统重启后不会自动恢复，需要手动重新启动或配合 crontab @reboot。

---

## 方案 D：tmux 会话

**适用条件**：
- `which tmux` 有输出
- 无 screen，或用户偏好 tmux

**部署步骤**：

```bash
# 1. 清理
pkill -f "xiachong-connect.py" 2>/dev/null || true
tmux kill-session -t xiachong 2>/dev/null || true

# 2. 启动
tmux new-session -d -s xiachong "cd __WORKDIR__ && OPENCLAW_CLI=__OPENCLAW_PATH__ python3 -u xiachong-connect.py --relay __RELAY_URL__ --link-code __LINK_CODE__ --secret __SECRET__ 2>&1 | tee xiachong.log"

# 3. 验证
sleep 3
tmux list-sessions | grep xiachong
tail -20 __WORKDIR__/xiachong.log
```

**管理命令**：
```bash
# 进入 tmux 查看
tmux attach -t xiachong

# 退出（不终止）：按 Ctrl+B 然后按 D

# 终止
tmux kill-session -t xiachong
```

---

## 方案 E：nohup + disown（通用后备）

**适用条件**：
- 所有 Unix/Linux/macOS 系统
- 其他方案都不可用时的最后手段

**部署步骤**：

```bash
# 1. 清理旧进程
pkill -f "xiachong-connect.py" 2>/dev/null || true
sleep 1

# 2. 启动
cd __WORKDIR__ && \
OPENCLAW_CLI=__OPENCLAW_PATH__ nohup python3 -u xiachong-connect.py \
  --relay __RELAY_URL__ \
  --link-code __LINK_CODE__ \
  --secret __SECRET__ \
  > xiachong.log 2>&1 & disown

# 3. 记录 PID
echo $! > xiachong.pid

# 4. 验证
sleep 3
ps -p $(cat xiachong.pid) && echo "进程运行中"
tail -20 xiachong.log
```

**管理命令**：
```bash
# 查看状态
ps -p $(cat __WORKDIR__/xiachong.pid) 2>/dev/null && echo "运行中" || echo "已停止"

# 查看日志
tail -f __WORKDIR__/xiachong.log

# 终止
kill $(cat __WORKDIR__/xiachong.pid)
```

**注意**：nohup 方案在系统重启后不会自动恢复。

---

## 第三步：验证连接成功

无论使用哪种方案，都需要验证：

```bash
# 1. 检查进程存在
ps aux | grep "xiachong-connect" | grep -v grep

# 2. 检查日志中是否有成功连接的标志
grep -E "已连接|connected|等待客户端" __WORKDIR__/xiachong.log | tail -5

# 3. 如果日志显示以下内容，说明成功：
#    [OK] 绑定成功，App ID: openclaw_xxxxxx
#    [OK] 已连接，等待客户端消息...
```

---

## 常见问题排查

> **重要**：本章节是**强制阅读**内容。在用户报告连接问题时，必须按顺序执行以下诊断步骤，不要跳过任何一步。

### 诊断第一步：检查是否有冲突进程（最常见原因！）

**这是最容易被忽略但最常见的问题**：用户机器上可能有多个 Connector 实例在竞争连接。

```bash
# 必须首先执行！查找所有正在运行的 xiachong 相关进程
ps aux | grep -E "xiachong|connector" | grep -v grep

# 检查 systemd 服务（即使用户说"没配置过"也要检查！用户可能忘了）
systemctl --user list-units --all | grep -i xiachong 2>/dev/null || echo "无 systemd 用户服务"
systemctl list-units --all | grep -i xiachong 2>/dev/null || echo "无 systemd 系统服务"

# 检查 launchd（macOS）
launchctl list 2>/dev/null | grep -i xiachong || echo "无 launchd 服务"

# 检查 screen/tmux 会话
screen -list 2>/dev/null | grep -i xiachong || echo "无 screen 会话"
tmux list-sessions 2>/dev/null | grep -i xiachong || echo "无 tmux 会话"
```

**诊断逻辑**：
- 如果发现任何运行中的进程或服务 → 这很可能就是问题根源
- 一个 agent_token 只能被一个进程使用
- 如果旧进程先抢到连接，新进程会一直失败

**解决步骤**：
```bash
# 1. 停止所有冲突进程
systemctl --user stop xiachong-connector 2>/dev/null || true
systemctl --user stop xiachong-relay 2>/dev/null || true  # 可能有旧名称
pkill -f "xiachong-connect" 2>/dev/null || true
screen -S xiachong -X quit 2>/dev/null || true
tmux kill-session -t xiachong 2>/dev/null || true

# 2. 确认已清理干净
ps aux | grep -E "xiachong|connector" | grep -v grep
# 应该没有输出

# 3. 删除可能冲突的旧凭证
rm -f ~/.config/xiachong/agent.json

# 4. 现在才开始重新配对
```

### 诊断第二步：检查凭证状态

```bash
# 检查是否存在 agent.json
cat ~/.config/xiachong/agent.json 2>/dev/null && echo "--- 上方是现有凭证 ---" || echo "无 agent.json，需要首次配对"

# 如果存在 agent.json，检查其内容是否完整
# 应该包含 agent_token 和 refresh_token 字段
```

**诊断逻辑**：
- 如果有 agent.json 且内容完整 → 不需要 link-code，直接用 token 重连
- 如果有 agent.json 但报错 "Invalid agent token" → 凭证已失效，需要删除并重新配对
- 如果无 agent.json → 需要用户提供 link-code 和 secret 进行首次配对

### 诊断第三步：检查日志错误信息

```bash
# 查看最近的日志（根据使用的方案选择）
# systemd
journalctl --user -u xiachong-connector -n 50 --no-pager 2>/dev/null || true

# 日志文件
tail -50 ~/xiachong.log 2>/dev/null || true
tail -50 ~/.xiachong/xiachong.log 2>/dev/null || true

# 查找关键错误模式
grep -E "error|Error|失败|断开|Invalid|expired|conflict" ~/xiachong.log 2>/dev/null | tail -20
```

**常见错误及含义**：
| 错误信息 | 含义 | 解决方向 |
|---------|------|---------|
| "Invalid agent token" | agent.json 中的 token 已失效 | 删除 agent.json，重新配对 |
| "Invalid link code" | link-code 错误或已过期 | 从客户端获取新的 link-code |
| "Connection refused" | 服务器不可达 | 检查网络、DNS、防火墙 |
| "Another client connected" | 有其他进程抢连接 | 回到诊断第一步 |
| "Session expired" | 服务端 session 过期 | 删除 agent.json，重新配对 |

### 诊断第四步：网络连通性

```bash
# 检查是否能访问 relay 服务器
curl -s -o /dev/null -w "%{http_code}" https://primo.evomap.ai/health || echo "无法访问 staging"
curl -s -o /dev/null -w "%{http_code}" https://xiachong-api.aged-sea-ee35.workers.dev/health || echo "无法访问 production"

# 检查 DNS 解析
nslookup primo.evomap.ai 2>/dev/null || host primo.evomap.ai 2>/dev/null || echo "DNS 解析失败"

# 检查是否有代理干扰
echo $http_proxy $https_proxy $HTTP_PROXY $HTTPS_PROXY
```

---

### 问题：找不到 openclaw 命令

**症状**：日志显示 `[!] 找不到 openclaw 命令`

**解决**：
```bash
# 查找 openclaw 实际位置
find ~ -name "openclaw" -type f 2>/dev/null
ls ~/.npm-global/bin/openclaw 2>/dev/null

# 方法1：添加到 PATH（永久）
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# 方法2：在启动命令中指定 OPENCLAW_CLI 环境变量
OPENCLAW_CLI=/home/user/.npm-global/bin/openclaw python3 -u xiachong-connect.py ...
```

### 问题：缺少 Python 依赖

**症状**：`ModuleNotFoundError: No module named 'websockets'`

**解决**：
```bash
pip3 install --user websockets requests
```

### 问题：连接后立即断开

**可能原因**：
1. link-code 或 secret 错误（仅首次配对时）
2. agent_token 已失效或被撤销
3. 网络问题
4. 服务器端 session 已过期

**解决**：
```bash
# 检查日志中的具体错误
tail -50 __WORKDIR__/xiachong.log | grep -E "error|Error|失败|断开"

# 检查是否已有 agent.json（如果有，会跳过 link-code 认证）
cat ~/.config/xiachong/agent.json 2>/dev/null || echo "无 agent.json，将使用 link-code 配对"

# 如果 agent_token 失效，删除后用新的 link-code 重新配对
rm -f ~/.config/xiachong/agent.json
# 然后获取新的 link-code 和 secret 重新启动
```

### 问题：客户端重启后 Connector 无法连接

**症状**：客户端重启、重新登录后，Connector 报错 "Invalid agent token" 或类似错误

**原因**：用户在客户端上点击了"断开 Connector"或手动解绑

**解决**：
```bash
# 删除旧的 agent.json
rm -f ~/.config/xiachong/agent.json

# 从客户端获取新的 link-code 和 secret
# 然后重启服务（或重新执行启动命令）
systemctl --user restart xiachong-connector  # 如果用 systemd
```

### 问题：需要更换绑定的客户端账号

**场景**：想让 Connector 连接到另一个用户的客户端

**解决**：
```bash
# 1. 删除旧凭证
rm -f ~/.config/xiachong/agent.json

# 2. 更新服务配置中的 link-code 和 secret（如果用 systemd）
nano ~/.config/systemd/user/xiachong-connector.service
# 修改 --link-code 和 --secret 参数

# 3. 重新加载并重启
systemctl --user daemon-reload
systemctl --user restart xiachong-connector
```

### 问题：systemd 服务无法启动

**检查**：
```bash
# 查看详细错误
systemctl --user status xiachong-connector
journalctl --user -u xiachong-connector -n 50

# 常见原因：路径错误、权限问题
# 确保 WorkingDirectory 和 ExecStart 中的路径都是绝对路径
```

---

## AI Agent 执行流程总结

1. **检测环境** - 运行第一步的检测命令
2. **选择方案** - 按优先级：systemd > launchd > screen > tmux > nohup
3. **获取参数** - 向用户确认 relay URL、link-code、secret
4. **执行部署** - 替换占位符后执行对应方案的命令
5. **验证成功** - 检查进程和日志
6. **告知用户** - 说明如何查看日志和管理服务

**关键提醒**：
- 不要对启动命令设置 `timeout` 参数
- 不要依赖 `background: true` + `yieldMs` 来保持进程
- 必须让进程脱离 AI session 的生命周期控制
- 首次配对成功后会生成 `~/.config/xiachong/agent.json`，后续重连不再需要 link-code
- 客户端重启刷新 link-code 不会影响已配对的 Connector

---

## 附录：兼容性矩阵

### 操作系统 × 持久化方案

**Linux (Debian/Ubuntu/Fedora/Arch)**
- systemd 用户服务：推荐，需要 systemctl + loginctl enable-linger
- screen/tmux：备选，需要安装
- nohup：兜底，所有发行版可用

**macOS**
- launchd：推荐，原生支持
- screen/tmux：需要 brew install
- nohup：兜底

**Windows (WSL2)**
- systemd：WSL2 默认启用 systemd，可用
- screen/tmux：需要 apt install
- nohup：可用

**Windows (原生)**
- 不支持本 skill，建议使用 WSL2

**FreeBSD/OpenBSD**
- screen/tmux：推荐
- nohup：可用
- 无 systemd

### OpenClaw 版本兼容性

**OpenClaw 26.x+**
- 完全兼容
- CLI 命令：`openclaw agent --session-id <label> --message <text>`

**OpenClaw 25.x**
- 兼容，但 `--session-id` 可能需要改为 `--label`
- 如遇问题，检查 `openclaw agent --help`

**OpenClaw < 25.x**
- 不保证兼容，建议升级

### AI Agent 平台兼容性

**OpenClaw TUI / Kimi Claw**
- exec 工具支持 `background: true`，但进程会随 session 终止
- 必须用 nohup/screen/systemd 脱离 session

**Claude Code**
- Bash 工具支持后台运行
- 推荐用 systemd 或 nohup

**Cursor / Windsurf**
- 终端命令会随编辑器关闭终止
- 必须用 systemd/launchd 持久化

### 安全机制兼容性

**OpenClaw 沙箱模式**
- Connector 脚本只调用 `openclaw agent` CLI，不受沙箱限制
- 无需特殊配置

**OpenClaw 审批模式**
- 首次运行脚本可能触发审批
- 审批通过后正常运行

**企业网络环境**
- 需要允许 WebSocket 出站连接到 relay 服务器
- 默认端口 443 (wss://)

### Python 版本兼容性

**Python 3.10+**
- 完全兼容

**Python 3.8-3.9**
- 基本兼容，但 `match` 语法不可用（当前脚本未使用）

**Python 3.7 及以下**
- 不兼容，asyncio API 差异太大
