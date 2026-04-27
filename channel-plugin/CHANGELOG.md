# Changelog

All notable changes to `@evopaimo/channel` will be documented here. This
project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are UTC (YYYY-MM-DD).

## [Unreleased]

## [0.1.2] — 2026-04-23

OpenClaw-side device observability + unbind-aware reconnect logic.

### Added

- **Device info reporting on pairing (P3)** — `pairWithRelay()` now
  accepts a `deviceInfo` payload (`hostname`, `platform`, `os_release`,
  `arch`, `plugin_version`) and forwards it to `/api/link` and
  `/api/agent-auth` under the `openclaw_device_info` key. Workers
  stamps this into `user_clients.openclaw_*` (migration `0031`) so the
  `/account/clients` dashboard can show which machine the OpenClaw is
  actually running on.
- `buildDeviceInfo()` helper in `runtime/pairing.ts` — clamps each
  field to 128 chars and swallows `os.hostname()` / `os.release()`
  throws (some sandboxed launchers raise).
- Plugin version is read from bundled `package.json` at module load
  via `createRequire(import.meta.url)`; a missing / unreadable
  `package.json` leaves the field unset rather than hard-failing.

### Changed

- **`ws-client.ts` — stop auto-reconnect on `WS_CLOSE.UNBOUND` (4004)**
  — when the relay closes our WebSocket with close code 4004 ("device
  unbound from dashboard"), the client now logs an `error` and
  marks itself `stopped = true` instead of entering the backoff loop.
  Reconnecting with a revoked `linkCode` would just spin forever; the
  user needs to re-pair the plugin before further progress is
  possible, and the log line tells the operator exactly that.

### Compatibility

- Back-compat safe: server treats missing `openclaw_device_info` as
  "keep existing columns unchanged". Older plugin builds that don't
  send the payload continue to work, they just show blank in the
  dashboard until they update.

## [0.1.1] — 2026-04-22

Security hardening release. Closes the gaps surfaced by the Phase-2
connector security audit (see
[`docs/specs/openclaw-hooks-integration/connector-security-audit-2026-04-22.md`](../../docs/specs/openclaw-hooks-integration/connector-security-audit-2026-04-22.md)).
No protocol-breaking changes; Electron client and Workers relay need no
update.

### Security — P0 fixes

- **`relayUrl` scheme whitelist (P0-1)** — `resolveAccount()` now
  rejects `http://`, `ws://`, `file://`, `javascript:`, and any URL
  whose protocol is not exactly `https:`. A misconfigured (or
  attacker-tampered) `~/.openclaw/openclaw.json` previously could route
  pairing + WS traffic over cleartext, exposing `linkCode + secret` and
  the relay JWT to any on-path observer.
- **`init_request.prompts` array length cap (P0-2)** — at most
  `MAX_INIT_PROMPTS_PER_REQUEST = 32` prompts per frame. A malicious
  relay could previously ship 100 k prompts and burn the user's entire
  LLM token budget in one frame.
- **`init_request.prompts[i].prompt` / `expect` size cap (P0-3)** —
  each capped at `MAX_INIT_PROMPT_LENGTH = 32_000` characters. A single
  multi-MB prompt no longer OOMs the gateway process during JSON parse +
  envelope wrap.
- **`init_request.agent_id` strict allowlist (P0-4)** — must match
  `^[A-Za-z0-9_.\-]+$` and be ≤ `MAX_AGENT_ID_LENGTH = 64`. Closes log
  injection (newlines, ANSI escapes), path traversal (`../`,
  `/etc/passwd`), and prompt injection via the identity field.

### Security — P1 fixes / defense in depth

- **`message.from` sanitiser (P1-1)** — exported `sanitizeFromField()`
  strips C0/C1 control characters, path separators, and quote marks,
  caps to `MAX_FROM_LENGTH = 128`. Used by `account-runtime.ts` before
  every `from` is interpolated into a log line, and by `dispatch.ts`
  before it is interpolated into the LLM-visible envelope `From:`
  header.
- **Defense-in-depth `agent_id` sanitiser** — `sanitizeAgentId()` is
  applied a second time inside `dispatchInitPrompt()` so that even a
  hypothetical future code path that bypasses `parseInboundFrame` still
  produces a safe session label / store path / envelope identifier.
- **Stricter `parseInboundFrame()` for `init_request`** — explicit
  per-prompt validation (`prompt` is a string, `step` is a number when
  present, `expect` is bounded). Surfacing protocol violations as
  thrown errors makes them visible at WARN level instead of being
  silently dispatched.

### Added

- `src/security.test.ts` — 19 attack-scenario regression tests
  covering each P0/P1 finding above. Every test was authored as RED
  before the corresponding patch landed and now stays GREEN as a
  permanent guardrail.

### Added (carried over from Unreleased)

- Per-frame INFO logging in `account-runtime.ts` so operators can
  observe inbound `message` / `init_request` traffic and outbound
  reply frames without flipping the whole plugin to DEBUG. Content
  bodies are truncated to 80 chars in logs to avoid leaking full
  message text.

## [0.1.0] — 2026-04-22

Initial pre-release. Everything below landed together during Phase 2 of
the "connector-as-channel-plugin" effort
(see [`docs/specs/openclaw-hooks-integration/plan-phase-2.md`](../../docs/specs/openclaw-hooks-integration/plan-phase-2.md)).

### Added

- TypeScript channel plugin conforming to OpenClaw SDK
  `openclaw/plugin-sdk/channel-contract`.
- `ChannelGatewayAdapter` with long-lived `startAccount` promise, so
  the gateway never mistakes the channel for a dead account during
  normal operation (no more `auto-restart attempt N/10` loop).
- Relay WebSocket client (`src/runtime/ws-client.ts`) with
  exponential backoff reconnect and reactive `ping`/`pong` handling
  that mirrors the Python `evopaimo-connect.py` wire protocol.
- HTTP pairing flow (`src/runtime/pairing.ts`) reusing the existing
  `/api/link` + `/api/agent-auth` endpoints on the Cloudflare Workers
  relay. The plugin persists `agent_token` + `appId` + `agentId`
  locally so re-pairing is needed only when the token is revoked.
- Persistence under `~/.openclaw/channels/evopaimo/state-<accountId>.json`
  (mode `0600`), with **automatic migration** from the legacy location
  `~/.openclaw/extensions/evopaimo/` so upgrading the plugin never
  strands existing agents.
- Inbound dispatch (`src/runtime/dispatch.ts`) wraps user messages in
  the `EMOTION_PROMPT` envelope and parses the LLM's strict-JSON reply
  into `{emotion, full_text, tts_text}` — identical to the Phase 1 CLI
  behavior, so the Electron client sees no observable wire change.
- Unit tests covering protocol parsing, emotion envelope, DM policy
  resolution, and pairing happy-path + credential rotation.
- Manifest (`openclaw.plugin.json`) + scoped config schema (`channels.evopaimo.*`).
- Vite-style build via `tsup` producing ESM-only output and `.d.ts`
  bundles, consumable by OpenClaw's plugin loader.

### Notes for operators

- The security scanner will flag one info-level warning on install:
  `plugins.code_safety — potential-exfiltration` (because
  `pairing.ts` reads a local file and issues `fetch`). This is the
  intended `agent_token` persistence + relay handshake path and has
  been audited. Operators can ignore the warning.
- First-time `openclaw plugins install @evopaimo/channel` needs the
  `channels.evopaimo` section present in `~/.openclaw/openclaw.json`
  **before** install runs the config audit. See the plugin README's
  "Re-install gotcha" for the one-liner that temporarily strips the
  block for a clean install.

[Unreleased]: https://github.com/EvoMap/XiaChong/compare/channel-plugin-v0.1.1...HEAD
[0.1.1]: https://github.com/EvoMap/XiaChong/compare/channel-plugin-v0.1.0...channel-plugin-v0.1.1
[0.1.0]: https://github.com/EvoMap/XiaChong/releases/tag/channel-plugin-v0.1.0
