# npm 包首发 Onboarding（给持 npm 账号的同事）

> ## ⚠️ DO NOT FOLLOW THIS DOCUMENT AS-IS (PENDING)
>
> **Status (2026-04-22)**: 首次 npm publish 当前**不安排**。原因：项目优先级调整，目前用 GitHub mirror + R2 直链已经能覆盖所有用户场景，不再阻塞团队。
>
> **如果你刚被发到这份文档**：请先停手，去找王浩宇确认是否真的要重启 npm 通道。重启的判断条件、操作步骤、需要协调的人见 [`channel-plugin/HANDOVER.md` §"npm 通道重启清单"](./channel-plugin/HANDOVER.md#npm-通道重启清单)。
>
> **如果确认要重启**：先把 `.github/workflows/publish-connectors.yml` 里被注释的 `Publish connector to npm` step 反注释掉，再按本文照常做 Part A + Part B。

---

> **请 15 分钟内读完**。做完 Part A + Part B 总共 10-20 分钟，之后你基本不用再碰这件事。

---

## 你是谁、为什么收到这份文档

- 你是团队里**持有 npm 发布账号**的同事。
- EvoPaimo 的 desktop client（历史代号 XiaChong，现在叫 EvoPaimo/虾宠）有一个叫 `connector` 的 Python 中继脚本。我们想把它发成一个 npm 包 **`evopaimo-relay-connect`**，让用户一条 `npx evopaimo-relay-connect ...` 就能跑起来。
- 这个包在 npm registry 上**从来没被发布过**。npm 的 Trusted Publishing（CI 无密钥自动发版）要求**先由人手动发第一次**才能激活——这就是为什么需要你。
- 做完之后，CI 会用 GitHub OIDC Trusted Publishing 自动发版，**不再需要你每次介入**。

---

## 你需要做的两件事

| 编号 | 内容 | 预计耗时 |
|---|---|---|
| **Part A** | 在你自己的电脑上跑一次 `npm publish`，把 `evopaimo-relay-connect@1.3.0` 推到 npm | 10 分钟 |
| **Part B** | 去 npmjs.com 网页上配置 Trusted Publisher，绑定到 GitHub CI | 3 分钟 |

做完你就结束了。之后任何 connector 版本更新，王浩宇（或他指派的 maintainer）只要 bump `connector/package.json` 的 version 字段 + push，CI 会自动发新版。

---

## Part A · 首次手动发布（10 分钟）

### 前置检查

在你电脑上：

```bash
# 1. 你的 npm 账号已经存在，并且开了 2FA
npm whoami
# 应该输出你的账号名，例如 'wanghao-xy' 或 'evopaimo-team'

# 2. Node 16+
node --version
# 应该是 v16.x 或更高。推荐 v20+

# 3. git 能正常 clone 公开仓库（不需要 SSH key，公开仓库 HTTPS 即可）
```

如果 `npm whoami` 报 "Not logged in"，先：

```bash
npm login
# 输入账号 / 密码 / 邮箱 / 2FA OTP
```

如果你还没开 2FA，去 https://www.npmjs.com/settings/~/profile 开启——**npm 强制要求 publisher 开 2FA**，否则 publish 会被拒。

### 发布流程

```bash
# 1. 拉代码
git clone https://github.com/EvoMap/XiaChong.git
cd XiaChong/connector

# 2. 检查当前版本号（应该是 1.3.0）
cat package.json | grep '"version"'

# 3. 先 dry-run，检查要发什么东西（可以无限次反悔）
npm publish --dry-run --access public
```

**你应该看到类似这样的输出**（关键是 `name` 和 `Tarball Contents`）：

```
npm notice 📦  evopaimo-relay-connect@1.3.0
npm notice Tarball Contents
npm notice 3.9kB  README.md
npm notice 2.1kB  bin/run.js
npm notice 65kB   evopaimo-connect.py
npm notice 1.2kB  package.json
npm notice 45B    requirements.txt
npm notice === Tarball Details ===
npm notice name:          evopaimo-relay-connect
npm notice version:       1.3.0
npm notice filename:      evopaimo-relay-connect-1.3.0.tgz
npm notice unpacked size: 72.5 kB
```

> 如果你看到 `name:` 不是 `evopaimo-relay-connect`，或者 version 不是 `1.3.0`，**先停住来问我们**——不要继续。

```bash
# 4. 正式发布（这一步是真的往 npm 推了）
npm publish --access public
# 系统会要求输入 npm 2FA OTP（6 位数字），从你的 Authenticator app 拿
```

**成功的话你会看到**：

```
+ evopaimo-relay-connect@1.3.0
```

### 立刻验证

```bash
# 任意机器都能跑
npm view evopaimo-relay-connect version
# 应输出：1.3.0

npm view evopaimo-relay-connect dist-tags
# 应输出：{ latest: '1.3.0' }
```

看到这两个输出就 Part A 完成了。往下走 Part B。

---

## Part B · 配置 Trusted Publisher（3 分钟）

这一步让 GitHub CI 以后能代替你自动发版。

1. 浏览器打开：https://www.npmjs.com/package/evopaimo-relay-connect
2. 右上角点 **`Settings`**（只有 owner 才看得到这个入口——你刚发完包，你就是 owner）
3. 左侧菜单选 **`Trusted Publishers`**
4. 点 **`Add Trusted Publisher`**
5. Publisher type 选 **`GitHub Actions`**
6. 填以下字段：

| 字段 | 填什么 |
|---|---|
| **Organization or user** | `EvoMap` |
| **Repository** | `XiaChong` |
| **Workflow filename** | `publish-connectors.yml` |
| **Environment** | *（留空，不要填任何东西）* |

7. 点页面底部的 **`Add Publisher`** 保存

> 如果看到 repository owner 叫 `Neon-Wang` 或者别的——以下面 8. 提到的方法确认一下再填。

### 验证 Trusted Publisher 配对成功

打开：
https://github.com/EvoMap/XiaChong/actions/workflows/publish-connectors.yml

点右上角 **`Run workflow`** 按钮（dropdown 里 branch 保留 `main` 默认）→ **`Run workflow`**。

等 2 分钟刷新，你应该看到一次新的绿勾 ✅ workflow run。点进去查看 `Publish connector to npm` step 的日志，应该输出：

```
Version 1.3.0 of evopaimo-relay-connect is already published.
```

**看到这句就说明 Trusted Publishing 绑定成功**——以后 CI 能自动发新版，不需要任何 npm 账号介入。

---

## 做完之后

- 给王浩宇（或通知你的人）回复：**"1.3.0 已发 + Trusted Publisher 已绑定 + workflow_dispatch 跑通"**
- 把 npm 账号的密码 / 2FA 继续由你保管，**不需要共享给其他人**
- 如果以后这个 npm 账号要变更或交接，提前通知 repo maintainer——因为 Trusted Publisher 绑定是在账号维度的，变更账号意味着要重配 Trusted Publisher

---

## 如果卡住了

### "我 dry-run 看到 `name:` 不是 evopaimo-relay-connect"

**停下**。说明你 clone 的代码不对，或者同事本地改过 `package.json`。**不要继续 publish**，先联系王浩宇确认。

### "我跑 `npm publish` 报 E403 Forbidden / Permission denied"

可能是这几个原因：
- 账号名被别人占了（这个包名被别人抢注了）→ 截图错误信息发给王浩宇
- 你的账号没开 2FA → 按上面"前置检查"里说的步骤开 2FA
- 你登录的 npm 账号和预期不符 → 重跑 `npm whoami` 确认

### "我跑 `npm publish` 报 E404 / package not found"

这个错 **不会** 在 `npm publish` 时出现（发新包不会 404，只有安装不存在的包才会）。如果看到这个错，截图给王浩宇。

### "Trusted Publisher 页面找不到"

https://www.npmjs.com/package/evopaimo-relay-connect/access 这个路径也能进到同个地方。如果还是找不到，右上角确认你登录的是那个发布包的账号。

### "workflow_dispatch 触发后，publish step 仍然失败"

把 `gh run view <RUN_ID> --log-failed` 的输出（或 GitHub Actions 页面那次 run 的日志）截图发过来——十有八九是 Part B 那几个字段填错了（最常见是 `Repository` 填成 `EvoMap/xiachong` 小写，或者 `Workflow filename` 少了 `.yml`）。

---

## 你**不需要**做的事

以下这些都由 repo maintainer 负责，你不用管：

- 日常 bump 版本号发新版（每次 connector 改了代码）
- 写 changelog、发 release notes
- 处理 prerelease (rc/beta) 发布
- 回滚有问题的版本（deprecate / unpublish）
- R2 / Cloudflare / GitHub mirror 同步（CI 自动跑）

以上所有内容在 [`connector/RELEASE.md`](RELEASE.md) 里有详细说明——**那个是给 maintainer 长期参考的，你不用读**。

---

## 参考

- 完整发版手册（给 maintainer 读）：[`connector/RELEASE.md`](RELEASE.md)
- connector 技术架构：[`connector/README.md`](README.md)
- 本次发版相关的上下文（为什么 1.3.0 而不是 1.2.0）：[`docs/specs/openclaw-hooks-integration/POSTMORTEM.md`](../docs/specs/openclaw-hooks-integration/POSTMORTEM.md)（**不是必读**，只是想了解来龙去脉可以看一眼）
- npm Trusted Publishing 官方文档：https://docs.npmjs.com/trusted-publishers

---

**有问题联系**：王浩宇
