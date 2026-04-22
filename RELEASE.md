# Connector 发版流程（交接版）

> **谁该读这份文档**：拥有 npm 账号、负责发布 `evopaimo-relay-connect` 包的维护者
> **何时读**：交接 npm 账号后第一次发版前；或者发版失败需要排查时
> **不需要读**：只是改 connector 代码、不负责发版的开发者（你只需要照常 commit + push 到 `main`，CI 会按本流程自动跑）

---

## TL;DR

1. **npm 包名 `evopaimo-relay-connect` 当前在 npm registry 上不存在**（`npm view` 返回 404）。历史上 5 次 CI publish 都因为这个原因 fail——Trusted Publishing **不能凭空创建一个新包**，第一次必须用本地 `npm publish` 手动建出来。
2. 一旦第一次手动发完 + 在 npmjs.com 配好 Trusted Publishing 绑定，**之后每次只要 bump `connector/package.json` 的 `version` 字段 + commit + push 到 `main`，CI 会自动 publish**。
3. CI workflow：[`.github/workflows/publish-connectors.yml`](../.github/workflows/publish-connectors.yml)
4. 不需要在 GitHub Secrets 里存 `NPM_TOKEN`——用的是 OIDC Trusted Publishing。

---

## 现状（2026-04-22 截稿时）

| 维度 | 状态 |
|---|---|
| npm 包 `evopaimo-relay-connect` | ❌ **不存在**（`npm view evopaimo-relay-connect version` → 404） |
| 旧 npm 包 `xiachong-relay-connect` | ❌ **也不存在**（README 里写的"已 deprecate"是基于错误假设，实际从未发布过） |
| GitHub 镜像 `Neon-Wang/xiachong-relay-connect` | ✅ 存在且已 sync 到 hooks 集成代码（CI 的 sync 步骤是成功的，只有 npm publish 步骤失败） |
| Cloudflare R2 上的 `evopaimo-connect.py` | ✅ 已上传（CI 的 R2 步骤也是成功的）— 这意味着 `https://primo.evomap.ai/connector/evopaimo-connect.py` 一直能拉到最新脚本 |
| `connector/package.json` 版本号 | `1.2.0` |
| Phase 1 hooks 集成代码 | ✅ 已在 `origin/main`（commit `f0cc563`） |
| 上次 CI 运行 | failure（[run 24759763352](https://github.com/Neon-Wang/xiachong/actions/runs/24759763352)）— "404 Not Found - PUT /evopaimo-relay-connect" |

**也就是说**：当前用户跑 `npx evopaimo-relay-connect ...` 会拿到"找不到包"的错误。所有依赖 npm 安装路径的文档（`docs/openclaw-integration.md`、`PERSISTENT_SETUP.md` 等）暂时**只对从 git 主干直接跑 Python 脚本的用户有效**。

---

## 一、角色与权限

| 谁 | 需要什么 | 一次性还是持续 |
|---|---|---|
| 接手 npm 账号的同事（首次发版人） | npm 账号已加入 `evopaimo-relay-connect` 包的 owners 列表（首次发版后才有这个包） | 一次性 + 持续 |
| GitHub 仓库管理员（已是 Neon Wang） | 在 npmjs.com 把 GitHub repo 配成 Trusted Publisher | 一次性 |
| 后续发版人（任何 push 到 main 的人） | 只要有 monorepo write 权限就行，不需要 npm 凭据 | 持续 |

> npm Trusted Publishing 解释：CI 用 GitHub OIDC token 向 npm 证明"我是 `Neon-Wang/xiachong` 仓库的 `publish-connectors.yml` workflow"，npm 信任这条来源就允许它 publish。**不需要在 CI 里存 npm token**，泄露面更小。详见[官方文档](https://docs.npmjs.com/trusted-publishers)。

---

## 二、首次发布流程（仅一次，做完之后忘了它）

> **关键认知**：Trusted Publishing 必须先有包，才能配 publisher。所以"先在本地手动 `npm publish` 发第一次"是绕不开的一步——这是 npm 的设计选择，不是我们的 bug。

### Step 1 · 准备 npm 账号（约 5 分钟）

1. 同事登录 npm 账号（假设账号已存在）
2. **必须开启 2FA**（npm 强制要求 publisher 开 2FA，否则 publish 会被拒绝）
3. 检查账号能否在自己的 namespace 下发包：

```bash
npm whoami
# 应该输出账号名，例如 "evopaimo-team"
```

### Step 2 · 本地准备发布环境

在交接同事的电脑上：

```bash
# 1) 克隆 monorepo
git clone https://github.com/Neon-Wang/xiachong.git
cd xiachong

# 2) 切到要发版的 commit（一般是 main HEAD）
git checkout main
git pull

# 3) 检查 connector/package.json 当前版本号
cat connector/package.json | grep '"version"'
# 例如显示： "version": "1.3.0",
# 这个版本号必须 > npm 上当前的 latest 版本（首次发版时 npm 上没有任何版本，所以任意 1.x 都行）

# 4) 登录 npm
npm login
# 按提示输入账号 / 密码 / 2FA 验证码
```

### Step 3 · 本地 dry-run 验证（重要，可以反悔）

```bash
cd connector
npm publish --dry-run --access public
```

dry-run 输出应该包含：
- `name: evopaimo-relay-connect`
- `version: 1.3.0`（或你设定的版本）
- `Tarball Contents` 包含 5 个文件：`README.md` / `bin/run.js` / `evopaimo-connect.py` / `package.json` / `requirements.txt`
- `unpacked size` 在 70-80 kB 之间

如果有任何 ERROR 字样**先解决再继续**——这一步发现的问题改完不需要新 commit，直接重跑 dry-run 即可。

### Step 4 · 真正手动发布第一次

```bash
cd connector
npm publish --access public
# 系统会要求输入 npm 2FA OTP（6 位数字）
```

**预期输出**：

```
+ evopaimo-relay-connect@1.3.0
```

**验证发版成功**：

```bash
npm view evopaimo-relay-connect version
# 应输出 1.3.0（或你发的版本号）

npm view evopaimo-relay-connect dist-tags
# 应输出 { latest: '1.3.0' }
```

如果你不是从 1.3.0 起步，把上面命令里的版本号换成你实际发的版本（比如交接时还想先发 1.2.1 验证发版流程通畅，也是可以的）。

### Step 5 · 配置 Trusted Publishing（让以后 CI 自动接管）

1. 浏览器打开 `https://www.npmjs.com/package/evopaimo-relay-connect`
2. 点 `Settings`（package 维护者才看得到）
3. 找到 `Trusted Publishers` 部分，点 `Add Trusted Publisher`
4. 选 `GitHub Actions`
5. 填入：

| 字段 | 值 |
|---|---|
| Organization or user | `Neon-Wang` |
| Repository | `xiachong` |
| Workflow filename | `publish-connectors.yml` |
| Environment | （留空）|

6. 点 `Add publisher` 保存

### Step 6 · 验证 CI 下次能跑通

可以**不**急着发新版本，直接用 `workflow_dispatch` 手动触发一次 CI 跑空（因为 package.json 版本号没变化，CI 会跑到 publish 步骤但跳过 `npm publish`，正好验证 Trusted Publisher 是否配对了）：

1. 浏览器打开 `https://github.com/Neon-Wang/xiachong/actions/workflows/publish-connectors.yml`
2. 点右上角 `Run workflow` → `Run workflow`
3. 等约 1-2 分钟看结果
4. 进入这次运行的日志，"Publish connector to npm" 步骤应该输出：
   `Version 1.3.0 of evopaimo-relay-connect is already published.`

只要看到这行就说明 Trusted Publishing 配置正确，下次真发版时 CI 会自动 publish。

### Step 7 · 交接给团队（让其他人能继续发版）

1. **不要把 npm 账号的密码/2FA 共享给团队**——保留在交接同事手里
2. **任何后续 bump 版本号的 commit + push，CI 会自动用 Trusted Publishing 走 OIDC，不再需要 npm 账号介入**
3. 把这份文档转发给团队，告知"之后发版只要按下面《三、日常发版》的步骤就行"

---

## 三、日常发版流程（之后每次发版）

> **前提**：首次发布已完成，Trusted Publishing 已配置。

### 3.1 决定版本号（semver 约定）

| 情况 | 版本号变化 | 例 |
|---|---|---|
| 修 bug、内部优化、文档 | bump patch | `1.3.0` → `1.3.1` |
| 新增功能但向后兼容（如新增 CLI 子命令、新增 transport mode） | bump minor | `1.3.0` → `1.4.0` |
| 破坏性变更（删除参数、改默认行为） | bump major | `1.3.0` → `2.0.0` |
| 预发版（让灰度用户测） | 加 `-rc.N` / `-beta.N` 后缀 | `1.4.0-rc.1` |

> **prerelease 警告**：当前 CI 工作流**没有特殊处理 prerelease tag**——如果你 bump 成 `1.4.0-rc.1` 直接 push，npm 会把它**当作 `latest` 发**，新用户跑 `npx evopaimo-relay-connect` 会拉到 rc 版本。详见下方《四、Prerelease 流程》。

### 3.2 改 connector/package.json + 同步 README 行号

```bash
# 1) bump 版本号
cd connector
# 手动编辑 package.json 把 "version": "1.3.0" 改成你想发的版本
# 或者用 npm 自带的 bump 命令：
npm version patch --no-git-tag-version   # 1.3.0 → 1.3.1
npm version minor --no-git-tag-version   # 1.3.0 → 1.4.0
# 注意 --no-git-tag-version：本仓库不依赖 git tag 触发发版，只看 package.json 版本号
```

> 如果改了 README/文档里需要列出版本号的地方（如"自 1.3.0 起支持 hooks 模式"），一并改了。

### 3.3 commit + push

```bash
cd ..   # 回到 monorepo 根
git add connector/package.json connector/README.md  # 视实际改动而定
git commit -m "chore(connector): release v1.3.1"
git push origin main
```

> **不要**用 git tag 来触发发版——本仓库的发版触发器只看 `connector/package.json` 的 `version` 字段，与 git tag 无关。

### 3.4 监控 CI

```bash
gh run watch  # 等当前最新 run 跑完
# 或浏览器打开 https://github.com/Neon-Wang/xiachong/actions/workflows/publish-connectors.yml
```

CI 流程（约 2-3 分钟）：
1. **Sync connector to GitHub** — 同步 `connector/` 到 `Neon-Wang/xiachong-relay-connect`
2. **Upload connector artifacts to R2** — 上传 `evopaimo-connect.py`/`PERSISTENT_SETUP.md`/`docs/skills/evopaimo-connector-setup.md` 到 staging + prod 两个 R2 bucket
3. **Publish connector to npm** — 如果 `package.json` 的 `version` 比 npm 上现有 latest 新就 publish；否则跳过

### 3.5 验证发版结果

```bash
# 1) npm 上有新版本
npm view evopaimo-relay-connect version
# 应输出你刚发的版本号

# 2) GitHub 镜像同步了
gh api repos/Neon-Wang/xiachong-relay-connect/commits/main --jq '.commit.message'
# 应包含 "Sync from monorepo: <SHA>"

# 3) R2 端点能拉到最新脚本
curl -sI https://primo.evomap.ai/connector/evopaimo-connect.py | grep -i last-modified

# 4) npx 能装并跑
npx --yes evopaimo-relay-connect@latest --help
# 应输出 connector 的 help 文案，包含 setup / status 子命令（如果 1.3.0+）
```

### 3.6 通知 + 文档同步

- 在团队群里发 changelog 摘要（哪些 commit、用户可见变化、是否需要重新跑 setup）
- 如果有破坏性变化，更新 `docs/openclaw-integration.md` 和 `connector/PERSISTENT_SETUP.md`

---

## 四、Prerelease (rc/beta/alpha) 流程

### 4.1 当前 CI 的限制

`publish-connectors.yml` 第 100-114 行的 publish 命令：

```bash
npm publish --access public
```

没有 `--tag` 参数。这意味着**无论你发 `1.4.0` 还是 `1.4.0-rc.1`，npm 都会把它打成 `latest` tag**——新用户跑 `npx evopaimo-relay-connect` 会拉到 rc 版本，破坏 stable 渠道。

### 4.2 解决方案 A：临时绕过 CI，本地手动发 prerelease

适用于"偶尔发一个 rc 让虚拟机灰度测"，不想动 CI 的情况。

```bash
# 1) 改 package.json 但不要 commit/push（避免触发 CI）
cd connector
# 编辑 package.json 改成 1.4.0-rc.1
git stash    # 把改动先放一边

# 2) 在 stash 状态下手动发 prerelease（需要 npm 账号 + 2FA，所以这一步要由首次发版同事来做）
git stash pop
npm publish --tag next --access public
# --tag next 会把这个版本打到 'next' tag，不会污染 latest

# 3) 验证
npm view evopaimo-relay-connect dist-tags
# 应该看到 { latest: '1.3.x', next: '1.4.0-rc.1' }

# 4) 发完后把 package.json 还原回 stable 版本号（避免误推触发 CI 重发）
git checkout connector/package.json
```

灰度用户安装：

```bash
npx evopaimo-relay-connect@next ...
# 或显式指定版本
npx evopaimo-relay-connect@1.4.0-rc.1 ...
```

灰度通过后，把 package.json 改成 `1.4.0`（去掉 rc 后缀）+ commit + push，让 CI 自动发 stable。

### 4.3 解决方案 B：永久修 CI，让 prerelease 自动用 next tag

适合"以后会经常发 rc"的情况。修改 [`.github/workflows/publish-connectors.yml`](../.github/workflows/publish-connectors.yml) 的 publish 步骤：

```yaml
# 把这段（第 99-114 行）：
- name: Publish connector to npm
  run: |
    cd connector
    PACKAGE_NAME=$(node -p "require('./package.json').name")
    PACKAGE_VERSION=$(node -p "require('./package.json').version")

    PUBLISHED_VERSION=$(npm view $PACKAGE_NAME version 2>/dev/null || echo "none")

    if [ "$PACKAGE_VERSION" != "$PUBLISHED_VERSION" ]; then
      echo "Publishing $PACKAGE_NAME@$PACKAGE_VERSION..."
      npm publish --access public
    else
      echo "Version $PACKAGE_VERSION of $PACKAGE_NAME is already published."
    fi
    cd ..

# 改成：
- name: Publish connector to npm
  run: |
    cd connector
    PACKAGE_NAME=$(node -p "require('./package.json').name")
    PACKAGE_VERSION=$(node -p "require('./package.json').version")

    PUBLISHED_VERSION=$(npm view $PACKAGE_NAME version 2>/dev/null || echo "none")

    if [ "$PACKAGE_VERSION" = "$PUBLISHED_VERSION" ]; then
      echo "Version $PACKAGE_VERSION of $PACKAGE_NAME is already published."
      exit 0
    fi

    # Detect prerelease (含 '-' 的版本，如 1.4.0-rc.1, 1.4.0-beta.2)
    if [[ "$PACKAGE_VERSION" == *-* ]]; then
      NPM_TAG="next"
      echo "Publishing prerelease $PACKAGE_NAME@$PACKAGE_VERSION to tag '$NPM_TAG'..."
    else
      NPM_TAG="latest"
      echo "Publishing $PACKAGE_NAME@$PACKAGE_VERSION..."
    fi

    npm publish --access public --tag "$NPM_TAG"
    cd ..
```

改完后，下次 push 含 prerelease 版本号的 commit，CI 会自动按 `next` tag 发，不污染 latest。

> 是否要做 4.3 由维护者按需求决定。如果一年发不了一次 rc，方案 A（临时手动）就够了。

---

## 五、失败排查

### 5.1 看 CI 日志

```bash
# 列出最近 5 次 publish-connectors workflow 跑
gh run list --workflow=publish-connectors.yml --limit 5

# 看某次跑的失败 step 完整日志
gh run view <RUN_ID> --log-failed
```

### 5.2 常见错误对照表

| 错误信息（从 CI 日志拷贝） | 含义 | 解决方向 |
|---|---|---|
| `404 Not Found - PUT https://registry.npmjs.org/evopaimo-relay-connect` | 包不存在 + Trusted Publisher 没法创建包 | **回到《二、首次发布》**——同事必须先本地手动发一次 |
| `403 Forbidden - PUT ...` | 包存在但 Trusted Publisher 配错了 | npmjs.com 上检查 Trusted Publisher 的 `Workflow filename` 是不是 `publish-connectors.yml`、`Repository` 是不是 `Neon-Wang/xiachong` |
| `EOTP Need otp` 或 `OTP required` | 本地 publish 时 2FA 没输 | 重跑命令并输入 2FA OTP |
| `409 Conflict - cannot publish over previously published version` | 当前 package.json 版本号已经在 npm 上了 | bump 一个新版本号再 push（npm 不允许覆盖已发版本） |
| `EPUBLISHCONFLICT` | 同上 | 同上 |
| `npm error code E401 / Need auth` | 在 OIDC 模式下出现这个一般意味着 Trusted Publishing 没配 | 同 403 处理 |
| Sync to GitHub 步骤的 `fatal: could not read Username` | `CONNECTOR_DEPLOY_TOKEN` secret 缺失或失效 | GitHub repo Settings → Secrets → `CONNECTOR_DEPLOY_TOKEN`，更新成有 `Neon-Wang/xiachong-relay-connect` write 权限的 PAT |
| R2 上传步骤的 `Authentication error: 10000` | `CLOUDFLARE_API_TOKEN` 失效 | GitHub repo Settings → Secrets → `CLOUDFLARE_API_TOKEN`，到 Cloudflare dashboard 创建新 token |

### 5.3 手动重发

如果某次 CI 跑挂了，commit 没改但你想重跑：

```bash
gh workflow run publish-connectors.yml
gh run watch
```

### 5.4 紧急回滚

```bash
# 把上一次发的版本从 latest tag 上移除（不推荐，npm 一般不让 unpublish 24h 后的版本）
npm dist-tag rm evopaimo-relay-connect latest    # 临时让 npx 装不到任何版本——慎用

# 把某个旧版本重新设为 latest
npm dist-tag add evopaimo-relay-connect@1.3.0 latest

# Deprecate（不删除，但 npm install 时会警告）
npm deprecate evopaimo-relay-connect@1.4.0 "Bug in hooks fallback, use 1.3.0 or 1.4.1+"

# Unpublish（仅 24 小时内可用，且会触发 npm 审核）
npm unpublish evopaimo-relay-connect@1.4.0    # 强烈不推荐
```

> npm 默认禁止 unpublish 已经超过 72 小时的版本，避免破坏依赖图。**回滚的正确方式是发 patch 版本（1.4.1）修掉 bug**，不是 unpublish。

---

## 六、相关文件位置

| 文件 | 作用 |
|---|---|
| `connector/package.json` | npm 包元数据；改 `version` 字段触发发版 |
| `connector/bin/run.js` | npm 包的 `bin` 入口（`npx evopaimo-relay-connect` 跑这个 Node 脚本，它再 spawn Python 主脚本） |
| `connector/evopaimo-connect.py` | Python 主脚本（hooks transport + CLI fallback + setup/status 子命令） |
| `connector/requirements.txt` | Python 依赖（`bin/run.js` 启动时会自动 `pip install`） |
| `connector/README.md` | npm 包的 README（同时也作为 GitHub `Neon-Wang/xiachong-relay-connect` 的 README，因为 sync 步骤直接 rsync 整个 connector 目录过去） |
| `.github/workflows/publish-connectors.yml` | 发版 CI workflow |

> **特别注意**：`README.md` 里关于"npm 包名从 1.2.0 起为 evopaimo-relay-connect，旧 xiachong-relay-connect@1.1.x 已 deprecate" 这句话**事实上是错的**——两个包名都从未真正出现在 npm registry 上。首次发版完成后建议把这句话改成"npm 包名 `evopaimo-relay-connect`，自 v1.x.y 起首次发布"。

---

## 七、Trusted Publishing 是什么（背景知识）

如果你完全不熟悉 npm Trusted Publishing：

1. **传统方式**：在 GitHub Secrets 里存 `NPM_TOKEN`，CI 用这个 token 调 `npm publish`。问题：token 泄露 = 任何人能以你的身份发包。
2. **Trusted Publishing**：CI runner 向 GitHub OIDC provider 请求一个**短期 JWT**（每次 run 重新签发），里面带 claims `repository=Neon-Wang/xiachong`、`workflow=publish-connectors.yml`。npm registry 收到这个 JWT 后核对自己配置的 trusted publisher 列表，匹配上就允许 publish。
3. **优势**：仓库里不需要存任何 npm 凭据；token 短期 + 不可重放；只有指定 workflow 文件能 publish（其他 workflow 拿不到）。

详见 [npm Trusted Publishers 官方文档](https://docs.npmjs.com/trusted-publishers)。

---

## 八、Known Issues（写入文档让交接同事知道，但不阻塞发版）

1. **`bin/run.js` help 文案过时**：第 53-66 行的 `--help` 输出只列出了 `--relay --link-code --secret`，没有提 `setup` / `status` 子命令。不影响功能（参数会正确转发给 Python），但用户跑 `npx evopaimo-relay-connect` 不带参数时看不到子命令提示。
2. **README 关于"deprecate xiachong-relay-connect@1.1.x"的说明是虚构的**——见第六节末尾说明。
3. **CI 没处理 prerelease tag**——见第四节。

这些不阻塞首次发版，但建议第一次发完之后开个 issue 修一下。
