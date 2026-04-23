# Publishing `@evopaimo/channel`

> ## ⚠️ DO NOT FOLLOW THIS DOCUMENT AS-IS (PENDING)
>
> **Status (2026-04-22)**: 整个 npm 发布通道当前已搁置。`.github/workflows/publish-channel-plugin.yml` 中的 npm publish step **已注释掉**；如果你按本文 §2 的流程跑 `npm publish`，仓库里的 CI 不会接管，你要自己继续手动维护版本号。
>
> **当前真正生效的发版流程**（仅 R2 + GitHub Release 两条腿）：见 [`HANDOVER.md`](./HANDOVER.md#日常发版流程稳态)。简单说就是 bump `package.json.version` → commit → push tag `channel-plugin-vX.Y.Z`，CI 自动写 R2 和 Release，零人工。
>
> **本文什么时候有用**：等到有人决定重启 npm 通道时——那时候按 [`HANDOVER.md` §"npm 通道重启清单"](./HANDOVER.md#npm-通道重启清单) 一步步反向打开 workflow 注释，然后参考本文 §2-§3 走首发 + Trusted Publishing 绑定。本文剩余内容暂时冻结、不再单独维护，仅作历史参考。

---

> **Who reads this** (历史读者画像): maintainers cutting a new version of the OpenClaw
> channel plugin **via npm**.
> **Who does NOT read this**: contributors who only touch plugin code —
> just land your changes on `main`. The CI workflow handles R2 + Release.

---

## Current status (as of 2026-04-22)

| Dimension | State |
|---|---|
| npm package `@evopaimo/channel` | ❌ **not on npm** — CI publish step intentionally commented out |
| Trusted Publishing binding | ⏳ not configured (depends on first manual publish creating the package) |
| GitHub workflow R2 + Release lanes | ✅ [`publish-channel-plugin.yml`](../../.github/workflows/publish-channel-plugin.yml) — green |
| GitHub workflow npm lane | 🚫 **commented out**（搜 `# - name: Publish to npm` 可见） |
| Version in `package.json` | `0.1.1`（已通过 R2 + Release 发出） |

This is the same "Trusted Publishing needs the package to exist first"
chicken-and-egg problem we already walked through with
`evopaimo-relay-connect`. Steps below assume nobody has published the
package yet — and will **only** be reachable after [`HANDOVER.md`'s npm
restart checklist](./HANDOVER.md#npm-通道重启清单) is completed.

---

## 1. Roles & permissions

| Person | Needs | One-time or recurring |
|---|---|---|
| First publisher (colleague with npm account) | npm user added as owner of the future `@evopaimo` scope; 2FA enabled | one-time |
| GitHub repo admin (Neon Wang today) | npm → Package settings → Trusted Publishing → add GitHub org/repo/workflow | one-time |
| Subsequent releasers (anyone with `main` write access) | Just monorepo write access; no npm credentials required | recurring |

> **Why Trusted Publishing?** CI exchanges a GitHub OIDC token for an
> npm access token at publish time. We never store `NPM_TOKEN` anywhere,
> which eliminates the leaked-token blast radius. Full explanation in
> the [npm docs](https://docs.npmjs.com/trusted-publishers).

---

## 2. First publish (do this once, then forget it)

### Step 1 — Prepare the npm account (~5 min)

1. The colleague who owns the `@evopaimo` scope logs in. If the scope
   doesn't exist yet:
   ```bash
   npm login
   # visit https://www.npmjs.com/settings/<you>/packages and create the
   # @evopaimo organization (npm will let you pick between "free" and
   # paid tiers — free is fine for public packages).
   ```
2. **Enable 2FA** (`Account settings → Security → 2FA (required for publish)`).
   npm rejects publishes from accounts without 2FA.
3. Confirm you can publish to the scope:
   ```bash
   npm whoami            # should print your npm username
   npm access ls-packages # the @evopaimo scope should appear once created
   ```

### Step 2 — Build & publish from a local clone (~5 min)

```bash
git clone https://github.com/EvoMap/XiaChong.git
cd XiaChong
git checkout main
git pull

# from the monorepo root, install pnpm workspaces (the channel-plugin is
# a workspace member so this brings in its dev deps too):
pnpm install

cd connector/channel-plugin

# Sanity gate — these must all pass before publishing:
pnpm typecheck
pnpm test
pnpm build

# Inspect what will go into the tarball. Only dist/, openclaw.plugin.json,
# README.md, and package.json should be in there.
pnpm pack --dry-run

# Publish with 2FA prompt.
# --access public is required for scoped packages to default to public.
npm publish --access public
```

After `npm publish` succeeds:

1. Verify on https://www.npmjs.com/package/@evopaimo/channel
2. `npm view @evopaimo/channel version` should print `0.1.0`.
3. Run a smoke test on the VM using the freshly-published package:
   ```bash
   ssh xc-debian "openclaw plugins install @evopaimo/channel"
   ```

### Step 3 — Wire up Trusted Publishing (~5 min)

On https://www.npmjs.com/package/@evopaimo/channel → **Settings** →
**Trusted Publishing** → **Add a new trusted publisher**:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `EvoMap` |
| Repository | `XiaChong` |
| Workflow filename | `publish-channel-plugin.yml` |
| Environment (optional) | leave blank |

Save. From this point on, any push to `main` that touches the plugin
(and bumps the version) will auto-publish without an `NPM_TOKEN`.

Once done, **hand the npm account back** to its owner — the workflow
does not need human credentials anymore.

---

## 3. Subsequent releases (recurring)

1. Land all changes on `main` via normal PR review.
2. Bump `connector/channel-plugin/package.json` `version` according to
   semver:
   * Patch (`0.1.0 → 0.1.1`): bug fixes, log changes, docs.
   * Minor (`0.1.0 → 0.2.0`): backwards-compatible config additions
     (new optional field, new log line downstream may rely on).
   * Major (`0.x → 1.0.0`): breaking change to config schema, wire
     protocol, or plugin contract.
3. Append a section to [`CHANGELOG.md`](./CHANGELOG.md) (follow the
   "Keep a Changelog" format already used there).
4. Commit with `chore(channel-plugin): release <version>` and push to
   `main`.
5. Tag & push:
   ```bash
   git tag channel-plugin-v0.1.1
   git push origin channel-plugin-v0.1.1
   ```
6. CI runs [`publish-channel-plugin.yml`](../../.github/workflows/publish-channel-plugin.yml):
   typecheck → test → build → compare `package.json` version against
   npm → publish if higher → mirror to the public relay repo.
7. Watch the workflow: `gh run watch --repo EvoMap/XiaChong`.
8. Smoke on the VM:
   ```bash
   ssh xc-debian "
     openclaw plugins update @evopaimo/channel && \
     openclaw gateway restart
   "
   # then send a test message from Electron; should see:
   # [evopaimo] paired via agent-auth (appId=… agentId=…)
   ```

---

## 4. When CI publish fails

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm ERR! 404 '@evopaimo/channel@<ver>' not found` | Package doesn't exist yet on npm. Trusted Publishing can't bootstrap a new package. | Run Section 2 once (manual first publish). |
| `npm ERR! 403 Forbidden … you do not have permission to publish` | Trusted publisher not configured, or workflow filename / repo mismatch. | Check the binding in npm → Package settings. Workflow filename must be **exactly** `publish-channel-plugin.yml`. |
| `npm ERR! 409 Conflict` | `package.json` version equals what's on npm. | Bump the version. The workflow skips publish when versions match, so this usually means the tag fired after a merge that forgot to bump. |
| `No matching OIDC token` | Workflow missing `id-token: write` permission. | Already set in `publish-channel-plugin.yml`. If changed, re-add under `permissions:`. |
| Build passes but `pnpm test` fails in CI only | Vitest running against bundled output vs. source — usually a stale snapshot. | Regenerate locally, commit, retry. |

---

## 5. Rollback / unpublish

npm allows unpublishing within **72 hours** of publishing. After that
only deprecation is possible.

* **Within 72h, bad release**:
  ```bash
  npm unpublish @evopaimo/channel@0.1.1
  # re-publish the previous good version? No — npm blocks reuse of
  # unpublished versions. Bump to 0.1.2 instead with the fixed code.
  ```
* **After 72h, bad release**:
  ```bash
  npm deprecate @evopaimo/channel@0.1.1 "Broken; upgrade to 0.1.2+"
  ```
* **Critical security issue**: contact npm support in addition to the
  above (`security@npmjs.com`).

Do **not** force-pushing the release commit off `main` — that breaks
the workflow's "changed file" trigger for future runs and leaves the
bad version on npm anyway.

---

## 6. Handoff checklist (for Neon → colleague)

When you hand this off after the first publish:

- [ ] First publish completed (`npm view @evopaimo/channel version` shows `0.1.0`).
- [ ] Trusted Publishing configured (Section 3 checkbox ✅ on npmjs.com).
- [ ] Colleague's npm account added as package owner
      (`npm access grant read-write @evopaimo:maintainers @evopaimo/channel`).
- [ ] Colleague knows the VM smoke-test command (Section 3 step 8).
- [ ] This file (`PUBLISHING.md`) linked from the plugin's README.

After that, the flow collapses to: bump → changelog → commit → tag →
push → observe.
