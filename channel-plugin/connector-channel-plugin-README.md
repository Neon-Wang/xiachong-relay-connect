# @evopaimo/channel

EvoPaimo channel plugin for [OpenClaw](https://openclaw.com).

This package brings the EvoPaimo desktop pet (and its Cloudflare Workers
relay backbone) into OpenClaw as a native **channel plugin** — the same
shape OpenClaw uses for Slack, Telegram, Discord, WhatsApp, etc.

It replaces the Python CLI connector (`evopaimo-relay-connect`) as the
preferred way to run an EvoPaimo-enabled OpenClaw. The CLI connector
remains available as a fallback when users prefer not to install plugins.

---

## Status

| Phase | Milestone | Status |
|---|---|---|
| Phase 2 | M1: Skeleton + plugin loads in OpenClaw | ✅ |
| Phase 2 | M2: WebSocket runtime + inbound dispatch | ✅ |
| Phase 2 | M3: Workers `/ws/openclaw` reused (no endpoint split) | ✅ |
| Phase 2 | M5: Full VM end-to-end green | ✅ (Electron → Workers → plugin → Kimi → back) |
| Phase 2 | M6a: R2 + GitHub Release distribution | ✅ (CI 自动写两条腿，2026-04-22 上线) |
| Phase 2 | M6b: npm publish + Trusted Publishing | ⏸ **PENDING** — 等 `@evopaimo` scope 持有人手动首发；workflow 中相应 step 已注释。详见 [`HANDOVER.md`](./HANDOVER.md#npm-通道重启清单) |
| Phase 2 | M4: Client "plugin online" indicator | ⏸ deferred |
| Sec 0.1.x | Hardening: P0/P1 fixes + 19 unit + 27 attack-sim | ✅ (see [Security](#security)) |

See [`docs/specs/openclaw-hooks-integration/plan-phase-2.md`](../../docs/specs/openclaw-hooks-integration/plan-phase-2.md)
for the detailed rollout plan.

---

## Install

> **End users**: read [`INSTALL.md`](./INSTALL.md) for the full step-by-step
> guide (download → sha256 verify → install → configure → pair → smoke).
> What follows here is the dev-loop quick reference.

Two active distribution lanes built from the same CI run (identical sha256):

| Lane | URL | Best for |
|---|---|---|
| GitHub Release | `https://github.com/EvoMap/XiaChong/releases/tag/channel-plugin-v<ver>` | Auditing, pinning specific versions |
| Cloudflare R2 mirror | `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz` | China-friendly direct download |
| ~~npm~~ | ~~`openclaw plugins install @evopaimo/channel`~~ | **PENDING** — package not on npm yet (CI publish step commented out). See [`HANDOVER.md`](./HANDOVER.md#npm-通道重启清单). |

```bash
# Quick install via R2 mirror:
curl -fL -o evopaimo-channel.tgz \
  https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz
curl -fL https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.sha256 \
  | shasum -a 256 -c -
openclaw plugins install ./evopaimo-channel.tgz

# PENDING — `openclaw plugins install @evopaimo/channel` will Just Work
# once the npm lane is reactivated (see HANDOVER.md). Until then use the
# tarball flow above.

# From a local .tgz (for dev loops):
cd connector/channel-plugin
pnpm install && pnpm build && pnpm pack
scp evopaimo-channel-0.1.2.tgz xc-debian:~/
ssh xc-debian "openclaw plugins install --force ~/evopaimo-channel-0.1.2.tgz"
# If config validation complains about a stale `channels.evopaimo`, see the
# "Re-install gotcha" section below.
```

### Re-install gotcha

`openclaw plugins install` runs config validation _before_ writing the new
plugin files. If a previous install already registered `channels.evopaimo`
but the plugin folder was removed, config validation will reject with:

```
Invalid config: channels.evopaimo: unknown channel id: evopaimo
```

Workaround during development: temporarily strip `channels.evopaimo` from
`~/.openclaw/openclaw.json`, install, then restore it. A small helper:

```bash
python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.openclaw/openclaw.json'
cfg = json.loads(p.read_text())
saved = cfg.get('channels', {}).pop('evopaimo', None)
p.write_text(json.dumps(cfg, indent=2))
pathlib.Path.home().joinpath('.openclaw/channels-evopaimo.saved.json').write_text(json.dumps(saved))
"
openclaw plugins install --force ~/evopaimo-channel-0.1.2.tgz
python3 -c "
import json, pathlib
p = pathlib.Path.home() / '.openclaw/openclaw.json'
cfg = json.loads(p.read_text())
cfg.setdefault('channels', {})['evopaimo'] = json.loads(
    pathlib.Path.home().joinpath('.openclaw/channels-evopaimo.saved.json').read_text())
p.write_text(json.dumps(cfg, indent=2))
"
```

After installing, restart the gateway so it picks up the new bundle:

```bash
openclaw gateway start     # systemd-managed; will restart if already running
```

---

## Configure

Edit `~/.openclaw/openclaw.json`:

```jsonc
{
  // Recommended: explicitly allowlist this plugin so unknown plugins don't
  // auto-load if you ever drop another tarball into ~/.openclaw/extensions/.
  "plugins": {
    "allow": ["evopaimo"]
  },
  "channels": {
    "evopaimo": {
      "relayUrl": "https://primo.evomap.ai",
      "linkCode": "ABC123",
      "secret": "64-hex-chars-from-electron-client",
      "sessionLabel": "mobile-app",
      "emotionWrapperEnabled": true,
      // Required to silence the OpenClaw audit `channels.evopaimo.dm.open`
      // CRITICAL warning. Our actual auth gate is the relay's linkCode +
      // secret pairing — anyone who can establish a WebSocket session has
      // already proven possession of the secret. See "Security" below.
      "allowFrom": ["*"]
    }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `relayUrl` | yes | Cloudflare Workers relay base URL (no trailing slash). `https://primo.evomap.ai` = staging. `https://xiachong-api.aged-sea-ee35.workers.dev` = production. |
| `linkCode` | yes | 6-char pairing code shown in the EvoPaimo desktop client's connection panel. |
| `secret` | yes | 64-hex shared secret emitted alongside `linkCode`. The plugin only uses it for the initial `/api/link` call; a long-lived `agent_token` is derived and persisted afterwards. |
| `sessionLabel` | no (default `mobile-app`) | Label recorded on each inbound session; shown in `openclaw status` and written into agent session metadata. |
| `emotionWrapperEnabled` | no (default `true`) | If true, wrap user messages in the `EMOTION_PROMPT` JSON envelope so the LLM returns `{emotion, full_text, tts_text}`. Disable only if the host agent already supplies its own emotion prompt. |
| `dmPolicy` / `allowFrom` | recommended | Forwarded to OpenClaw's DM policy check. Plugin runtime defaults to `open` with `allowFrom: ["*"]` because the relay's `linkCode + secret` pairing _is_ our allowlist, but `openclaw security audit` only sees the JSON file — write `"allowFrom": ["*"]` explicitly to silence the CRITICAL audit warning. |

The `linkCode` + `secret` come from the EvoPaimo desktop client. In
development builds the Electron main process logs the freshly provisioned
pair to stderr; in production users copy them from the client UI.

---

## Architecture

```
Electron client (renderer + main)
       │  WebSocket (authenticated)
       ▼
Cloudflare Workers (Hono + Durable Objects)
       │  WebSocket (/ws/openclaw?token=…)
       ▼
OpenClaw gateway (systemd / LaunchAgent)
       │  plugin loader
       ▼
@evopaimo/channel  ── this package ──
  ├─ src/channel.ts           ChannelPlugin object (manifest + DM policy)
  ├─ src/runtime/
  │   ├─ pairing.ts           /api/link + /api/agent-auth HTTP handshake
  │   ├─ ws-client.ts         WebSocket lifecycle (reconnect + reactive pong)
  │   ├─ account-runtime.ts   Per-account orchestrator; returns long-lived
  │   │                       promise that prevents gateway restart loop
  │   └─ dispatch.ts          Bridge inbound frames → OpenClaw agent
  └─ src/protocol.ts          Wire format (mirrors evopaimo-connect.py)
       │
       ▼
OpenClaw agent (kimi/k2p5, google/gemini-*, …)
```

### Lifecycle (one account)

1. `startAccount(ctx)` is called by the gateway; we instantiate the
   per-account runtime, register it, and `await runtime.run()` — **the
   promise stays pending until `stopAccount` is called**. This matters:
   resolving early is interpreted by the gateway as "the account exited"
   and triggers the auto-restart/backoff loop.
2. `pairing.ts` tries `/api/agent-auth` with a saved `agent_token`.
   On first run or if rejected, it falls back to `/api/link` with
   `linkCode + secret`, persists the new `agent_token`, and returns a
   short-lived WS `token`. **Since 0.1.2** both calls ship an
   `openclaw_device_info` payload (`hostname`, `platform`, `os_release`,
   `arch`, `plugin_version`) built via `buildDeviceInfo()`; the relay
   stamps it into `user_clients.openclaw_*` so the EvoPaimo website's
   `/account/clients` page can show "OpenClaw: mac-mini-2024 · macOS
   15.2 · plugin 0.1.2" next to each device.
3. `ws-client.ts` opens `wss://<relay>/ws/openclaw?token=…`, handles
   reactive `{type:"ping"}` frames with `{type:"pong"}`, and reconnects
   with exponential backoff. On 401/403 during handshake it asks the
   token resolver for a fresh token, wiping the stored `agent_token`
   before the next try.
   **Terminal close code 4004 (`WS_CLOSE.UNBOUND`) is special**: it
   means the user hit "解绑设备" on the web dashboard. We clear the
   persisted `agentToken`, mark the account snapshot as `healthState:
   "unbound"`, flip `stopped = true`, and refuse to reconnect — retrying
   with a revoked `linkCode` would spin forever. Re-pair via `openclaw
   plugins install` with fresh credentials from the dashboard. If
   `/api/link` returns 410 during token resolution, pairing clears the
   same stored credentials before surfacing the terminal error.
4. Inbound `message` / `init_request` frames are forwarded to
   `dispatch.ts`, which wraps the text in the emotion prompt (if
   enabled), calls `channelRuntime.reply.recordInboundSessionAndDispatchReplyWithBase()`,
   parses the strict-JSON emotion reply, and sends an outbound frame back
   over the WebSocket.

### State persistence

Per-account state lives at
`~/.openclaw/channels/evopaimo/state-<accountId>.json` with mode `0600`:

```json
{
  "agentToken": "<64-hex>",
  "agentId": "agent_xxxx",
  "appId": "openclaw_xxxx",
  "updatedAt": 1776873170444
}
```

> **Note** — older versions (≤ 0.1.0 preview) stored state inside
> `~/.openclaw/extensions/evopaimo/`. The runtime auto-migrates from that
> location on first read so plugin upgrades don't force re-pairing. The
> legacy file is left in place and becomes a no-op once the new path is
> populated.

---

## Security

This plugin runs **inside your local OpenClaw gateway process**, so any
malicious frame the relay sends becomes a malicious frame the LLM sees.
Treat the relay as **0% trusted** even if you operate it: we assume DNS
hijack, CA misissue, or the relay being compromised at any moment.

### Threat model in one paragraph

The trust boundary is the WebSocket between this plugin and the
Cloudflare Workers relay. We assume an attacker can: (a) MITM the wire
(L1/L2), (b) hold a valid `*.evomap.ai` certificate (L3), or (c) directly
control the relay backend (L4). Defenses must therefore live **inside
the connector**, not inside the relay.

### What 0.1.x enforces

| Defense | Where | What it blocks |
|---|---|---|
| `relayUrl` must be `https://` with a host | `src/config.ts` `validateRelayUrlScheme` | `http://attacker.evil/`, `ws://`, `file://`, `javascript:` — any cleartext or local-scheme path that would leak `linkCode + secret` |
| `init_request.prompts.length ≤ 32` | `src/protocol.ts` `parseInboundFrame` | Memory-exhaustion DoS via `prompts: Array(10_000_000)` |
| Each `prompt` / `expect` must be a string and ≤ 32 KB | same | Memory exhaustion via 1 GB single string or schema drift via object/array payloads |
| `agent_id` matches `^[A-Za-z0-9_.\-]+$`, length ≤ 64 | same | Log injection (`alice\n[FAKE]`), path traversal (`../../etc/passwd`), shell metacharacters |
| `message.content` ≤ 50 KB | same | Memory exhaustion |
| Unknown frame `type` rejected | same | `{type:"execute_shell"}` probing for future commands |
| Defense-in-depth `sanitizeFromField` / `sanitizeAgentId` | `src/runtime/dispatch.ts` + `src/runtime/account-runtime.ts` | Even if `parseInboundFrame` ever regresses, control chars / path separators / quotes / backticks are stripped before being interpolated into LLM `SenderName` / `From:` / log lines |

Pure validation logic lives in `src/config.ts` (no openclaw runtime
deps), `src/protocol.ts` (wire schemas + sanitizers). They are
re-exported through `dist/internals.js` so external auditors can verify
the *built* artifact, not just the source.

### Verify it yourself

```bash
# In the repo:
cd connector/channel-plugin && pnpm run attack-sim
# 27 attack scenarios run against dist/internals.js — exit 0 = all blocked

# Against a specific extension install (works today):
EVOPAIMO_DIST=/path/to/extensions/evopaimo/dist \
  node /path/to/extensions/evopaimo/scripts/attack-sim.mjs

# (PENDING) After the npm lane is reactivated, this will also work:
#   npx -p @evopaimo/channel evopaimo-channel-attack-sim
```

End-to-end demonstration: with 0.1.2 installed, edit `~/.openclaw/openclaw.json`
to set `relayUrl: "http://attacker.evil/"` and restart the gateway.
Expected outcome:

```text
[gateway] shutdown error: Error: evopaimo: channels.evopaimo.relayUrl
  must use https:// scheme to prevent credential interception
  (got="http://attacker.evil/", scheme=http:);
  configure a TLS-protected relay endpoint (e.g. https://primo.evomap.ai).
```

The connector never opens the WebSocket — `linkCode + secret` cannot leak.

### Known false positive: `plugins.code_safety` audit warning

`openclaw security audit --deep` flags `dist/index.js:447` and
`dist/setup-entry.js:447` as `[potential-exfiltration] File read combined
with network send`. This is a **false positive**:

- The flagged `fs.readFile` reads our own saved
  `~/.openclaw/channels/evopaimo/state-<accountId>.json` (the `agentToken`
  we cached during pairing for reconnection). Versions <= 0.1.0 may be
  migrated from `~/.openclaw/extensions/evopaimo/state-<accountId>.json`.
- The unrelated `ws.send` in the same bundle forwards user chat messages
  to the relay.
- There is no data path from "read agentToken" to "send agentToken over
  ws" — the token is only used as a Bearer header in `pairing.ts` and
  never appears in a frame body.

We deliberately do not split the bundle to suppress the warning, because
that would distort the architecture purely to placate a static scanner.
See the April 22 connector security audit notes (local reference, not published) for the full justification.

### What this plugin does NOT defend against

- A malicious user with **local file write** to `~/.openclaw/openclaw.json`.
  They can already replace your entire OpenClaw config or every plugin
  binary; the connector is not your last line of defense here. Protect
  `~/.openclaw/` with normal filesystem permissions.
- Compromise of the OpenClaw gateway process itself (a hostile plugin
  loaded alongside us). Use `plugins.allow: ["evopaimo"]` to limit which
  plugins can auto-load.
- A LLM that ignores prompt-injection on its own. We sanitize fields
  that *we* control before they reach the agent, but a sufficiently
  large pasted message body can still try to manipulate the LLM. That's
  a model-level concern, not a wire-level one.

### Reporting a security issue

Email `security@evomap.ai` (PGP key on the same domain). Do not open a
public GitHub issue for unfixed vulnerabilities.

---

## Testing

```bash
pnpm install
pnpm test              # vitest: protocol + emotion + channel + pairing + security
pnpm typecheck         # tsc --noEmit
pnpm build             # tsup → dist/index.js, dist/setup-entry.js, dist/internals.js, dist/*.d.ts
pnpm attack-sim        # 27 attack scenarios against dist/internals.js
pnpm ci                # typecheck + test + build + attack-sim
pnpm pack              # evopaimo-channel-0.1.2.tgz
```

### VM end-to-end smoke test

1. Start the Electron client in dev mode (`pnpm -C client electron:dev`).
   Grab the `linkCode` + `secret` from the dev log (Electron main logs
   both in development builds only).
2. Configure and install the plugin on the gateway host (see above).
3. Restart the gateway. Look for these log lines (in order):
   ```
   [evopaimo] started account default (relay=…)
   [evopaimo] evopaimo-ws: pairing: trying agent-auth with stored agent_token
   [evopaimo] paired via agent-auth|link (appId=… agentId=…)
   [evopaimo] evopaimo-ws: connecting accountId=default relayUrl=…
   [evopaimo] evopaimo-ws: open accountId=default
   ```
   There should be **no** `[evopaimo] [default] auto-restart attempt N/10`
   lines afterwards; seeing them means `startAccount` returned early
   (regression on the donePromise contract).
4. Send a message from the Electron client's chat UI. The agent should
   reply within ~20s (kimi/k2p5 median on local VM).

---

## Layout

```
connector/channel-plugin/
├── package.json              # npm package (name: @evopaimo/channel)
├── openclaw.plugin.json      # OpenClaw plugin manifest + configSchema
├── tsconfig.json
├── tsup.config.ts            # 3 entries: index, setup-entry, internals
├── index.ts                  # plugin runtime entry (loaded by gateway)
├── setup-entry.ts            # lightweight setup entry (CLI install)
├── internals.ts              # narrow public surface for attack-sim & auditors
├── scripts/
│   └── attack-sim.mjs        # 27 attack scenarios against dist/internals.js
├── src/
│   ├── channel.ts            # ChannelPlugin definition + DM policy (re-exports config)
│   ├── channel.test.ts
│   ├── config.ts             # leaf module: resolveAccount + URL validation (no openclaw deps)
│   ├── emotion.ts            # strict-JSON emotion parser (+ stripThinking)
│   ├── emotion.test.ts
│   ├── protocol.ts           # WebSocket frame schemas + sanitizers + length caps
│   ├── protocol.test.ts
│   ├── security.test.ts      # 19 vitest attack regressions
│   └── runtime/
│       ├── account-runtime.ts    # per-account orchestrator (donePromise)
│       ├── dispatch.ts           # inbound frame → agent reply dispatch (sanitizes here too)
│       ├── pairing.ts            # /api/link + /api/agent-auth
│       ├── pairing.test.ts
│       └── ws-client.ts          # WebSocket client with reactive pong
├── dist/                     # build output (gitignored)
└── README.md                 # this file
```

---

## Publishing (for maintainers)

**Active flow today** (R2 + GitHub Release): bump `connector/channel-plugin/package.json` `version`, commit, push, then tag `channel-plugin-vX.Y.Z` and `git push origin channel-plugin-vX.Y.Z`. CI builds, packs, uploads to R2 (staging + prod) and creates the GitHub Release. End-user impact: `https://xiachong-api.aged-sea-ee35.workers.dev/channel-plugin/latest.tgz` flips within a couple of minutes.

**npm lane (PENDING)**: The historical step-by-step in [`PUBLISHING.md`](./PUBLISHING.md) describes the npm Trusted Publishing flow. **Do not follow it as-is** — the workflow steps it references are commented out. Reactivation procedure is in [`HANDOVER.md`](./HANDOVER.md#npm-通道重启清单).

---

## References

- Spec: [`docs/specs/openclaw-hooks-integration/spec-2-channel-plugin.md`](../../docs/specs/openclaw-hooks-integration/spec-2-channel-plugin.md)
- Plan: [`docs/specs/openclaw-hooks-integration/plan-phase-2.md`](../../docs/specs/openclaw-hooks-integration/plan-phase-2.md)
- Phase 1 reference implementation: [`connector/evopaimo-connect.py`](../evopaimo-connect.py)
- OpenClaw Plugin SDK: `openclaw/plugin-sdk/channel-contract`
