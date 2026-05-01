/**
 * Pairing: exchange `linkCode + secret` (or a saved `agent_token`) for a
 * short-lived relay `token` that authorises the WebSocket connection.
 *
 * Mirrors Phase 1 `evopaimo-connect.py`:
 *   1. First run  → POST /api/link        { link_code, secret, agent_token }
 *                                          → { token, app_id, agent_id }
 *      We generate `agent_token` locally (64-hex) and persist it.
 *   2. Subsequent → POST /api/agent-auth  { agent_token }
 *                                          → { token, app_id, agent_id? }
 *      If the relay rejects the stored `agent_token` (e.g. agent deleted),
 *      fall back to the `/api/link` flow automatically.
 *
 * Persistence lives under `~/.openclaw/extensions/evopaimo/state-<accountId>.json`
 * with `0600` permissions; we never log secrets or tokens to gateway logs.
 */

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

export type PairingResult = {
  /** Short-lived WS auth token (`?token=` query param). */
  token: string;
  /** Opaque app id assigned by the relay. */
  appId: string;
  /** Server-known agent id (may be empty on first link). */
  agentId: string;
  /** Long-lived agent token persisted for future reconnects. */
  agentToken: string;
  /** Which HTTP endpoint produced the current `token`. */
  via: "link" | "agent-auth";
};

export type PairingLogger = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
  debug?: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * OpenClaw-side machine identity, sent alongside pairing requests so the
 * user's dashboard can show "connector: running on MacBookPro-16 · macOS
 * 15.2 · plugin 0.1.2" next to each device. Every field is optional so
 * the server can keep old entries blank without blowing up. Callers
 * should populate it via `buildDeviceInfo()` below; unit tests use the
 * trivial stub `{}`.
 */
export type DeviceInfo = {
  hostname?: string;
  platform?: string;
  os_release?: string;
  arch?: string;
  plugin_version?: string;
};

export type PairingOptions = {
  accountId: string;
  relayUrl: string;
  linkCode: string;
  secret: string;
  /** Override the persistence directory (tests). */
  stateDir?: string;
  /** Injection hook for unit tests. */
  fetchImpl?: typeof fetch;
  logger?: PairingLogger;
  /**
   * OpenClaw host identity. Included in `/api/link` and `/api/agent-auth`
   * request bodies so the dashboard can surface which machine is bound
   * to a given link_code. Omitted in unit tests that don't care.
   */
  deviceInfo?: DeviceInfo;
};

export type StoredAgentCredentials = {
  agentToken: string;
  agentId: string;
  appId?: string;
  updatedAt: number;
};

function normaliseRelayBase(relayUrl: string): string {
  return relayUrl.trim().replace(/\/+$/, "");
}

/**
 * Collect OpenClaw host machine identity to ship alongside pairing
 * requests. Keep the payload minimal — this is dashboard-observability,
 * not telemetry:
 *
 *   - `hostname` is best-effort (`os.hostname()` can throw under some
 *     container / sandboxed launchers; we clamp + swallow).
 *   - `platform` uses Node's canonical codes (darwin / win32 / linux / …).
 *   - `os_release` is e.g. `"24.3.0"` on macOS 15.3 — not a marketing
 *     name, but the backend maps the pair `(platform, os_release)` for
 *     display.
 *   - `arch` is arm64 / x64 / etc.
 *   - `plugin_version` is read from the bundled `package.json`; when
 *     unavailable (running from source / unit tests) we pass undefined
 *     and the server stays null.
 *
 * All fields are clamped to 128 chars to defend against pathological
 * hostnames. The server-side validation accepts up to 128 anyway, but
 * we also clamp here so noisy logs don't grow unboundedly.
 */
export function buildDeviceInfo(pluginVersion?: string): DeviceInfo {
  const clamp = (v: string | undefined): string | undefined => {
    if (!v) return undefined;
    const trimmed = v.slice(0, 128);
    return trimmed.length > 0 ? trimmed : undefined;
  };
  let hostname: string | undefined;
  try {
    hostname = os.hostname();
  } catch {
    hostname = undefined;
  }
  let release: string | undefined;
  try {
    release = os.release();
  } catch {
    release = undefined;
  }
  let arch: string | undefined;
  try {
    arch = os.arch();
  } catch {
    arch = undefined;
  }
  const info: DeviceInfo = {
    hostname: clamp(hostname),
    platform: clamp(process.platform),
    os_release: clamp(release),
    arch: clamp(arch),
    plugin_version: clamp(pluginVersion),
  };
  // Strip undefined keys — keeps the wire payload tidy and tests that
  // match on exact shape don't need to litter `undefined` keys.
  for (const k of Object.keys(info) as (keyof DeviceInfo)[]) {
    if (info[k] === undefined) {
      delete info[k];
    }
  }
  return info;
}

/**
 * Default state directory = `~/.openclaw/channels/evopaimo`.
 *
 * Intentionally placed *outside* `extensions/evopaimo/` so plugin upgrades
 * (`openclaw plugins install --force`) do not clobber the stored
 * `agent_token`.
 *
 * We also avoid reading any environment variables here — the OpenClaw
 * plugin security scanner flags `process.env` access combined with network
 * sends as "possible credential harvesting". Tests that need a different
 * directory pass `stateDir` explicitly through `PairingOptions`.
 */
export function defaultStateDir(): string {
  return path.join(os.homedir(), ".openclaw", "channels", "evopaimo");
}

function stateFilePath(stateDir: string, accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9_.-]+/g, "_");
  return path.join(stateDir, `state-${safe}.json`);
}

async function readStoredCredentials(
  stateDir: string,
  accountId: string,
  logger?: PairingLogger,
): Promise<StoredAgentCredentials | null> {
  const file = stateFilePath(stateDir, accountId);
  const attempt = await tryReadFile(file, logger);
  if (attempt !== "missing") return attempt;

  // Migration: versions <= 0.1.0 stored state under
  // `~/.openclaw/extensions/evopaimo/`. If we find a legacy file, adopt it
  // and persist to the new location on the next write.
  const legacy = path.join(
    os.homedir(),
    ".openclaw",
    "extensions",
    "evopaimo",
    `state-${accountId.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`,
  );
  if (legacy !== file) {
    const legacyResult = await tryReadFile(legacy, logger);
    if (legacyResult !== "missing") {
      if (legacyResult) {
        logger?.info?.("migrated stored agent_token from extensions/evopaimo/", {
          accountId,
        });
      }
      return legacyResult;
    }
  }
  return null;
}

async function tryReadFile(
  file: string,
  logger?: PairingLogger,
): Promise<StoredAgentCredentials | null | "missing"> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { agentToken?: unknown }).agentToken === "string" &&
      (parsed as { agentToken: string }).agentToken.length >= 32
    ) {
      return parsed as StoredAgentCredentials;
    }
    logger?.warn?.("stored credentials schema invalid", { file });
    return null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return "missing";
    logger?.warn?.(`read stored credentials failed: ${String(err)}`, {
      file,
    });
    return null;
  }
}

async function writeStoredCredentials(
  stateDir: string,
  accountId: string,
  creds: StoredAgentCredentials,
  logger?: PairingLogger,
): Promise<void> {
  const file = stateFilePath(stateDir, accountId);
  try {
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    logger?.warn?.(`mkdir state dir failed: ${String(err)}`, {
      dir: stateDir,
    });
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(creds, null, 2);
  await fs.writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* best effort */
  }
}

type RelayLinkResponse = {
  token: string;
  app_id: string;
  agent_id?: string;
};

async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; status: number; data?: RelayLinkResponse; raw?: string; errorDetail?: string }> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail: string | undefined;
    try {
      const obj = JSON.parse(text) as { error?: string; detail?: string };
      detail = obj.error ?? obj.detail ?? text;
    } catch {
      detail = text;
    }
    return { ok: false, status: res.status, raw: text, errorDetail: detail };
  }
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) as RelayLinkResponse };
  } catch {
    return { ok: false, status: res.status, raw: text, errorDetail: "invalid JSON body" };
  }
}

function generateAgentToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Obtain a fresh WS auth token. Tries saved `agent_token` first, then falls
 * back to the `link_code + secret` pairing path.
 *
 * Persists a rotating `agent_token` on every successful pairing.
 */
export async function pairWithRelay(opts: PairingOptions): Promise<PairingResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stateDir = opts.stateDir ?? defaultStateDir();
  const relay = normaliseRelayBase(opts.relayUrl);
  const logger = opts.logger;

  const stored = await readStoredCredentials(stateDir, opts.accountId, logger);

  if (stored?.agentToken) {
    logger?.info?.("trying agent-auth with stored agent_token", {
      accountId: opts.accountId,
    });
    const agentAuthBody: Record<string, unknown> = {
      agent_token: stored.agentToken,
    };
    if (opts.deviceInfo) {
      agentAuthBody.openclaw_device_info = opts.deviceInfo;
    }
    const res = await postJson(
      `${relay}/api/agent-auth`,
      agentAuthBody,
      fetchImpl,
    );
    if (res.ok && res.data?.token) {
      const result: PairingResult = {
        token: res.data.token,
        appId: res.data.app_id,
        agentId: res.data.agent_id ?? stored.agentId ?? "",
        agentToken: stored.agentToken,
        via: "agent-auth",
      };
      await writeStoredCredentials(
        stateDir,
        opts.accountId,
        {
          agentToken: stored.agentToken,
          agentId: result.agentId,
          appId: result.appId,
          updatedAt: Date.now(),
        },
        logger,
      );
      return result;
    }
    logger?.warn?.(
      `agent-auth rejected (status=${res.status} detail=${res.errorDetail ?? "?"}), falling back to link`,
      { accountId: opts.accountId },
    );
  }

  const agentToken = generateAgentToken();
  const linkBody: Record<string, unknown> = {
    link_code: opts.linkCode,
    secret: opts.secret,
    agent_token: agentToken,
  };
  if (opts.deviceInfo) {
    linkBody.openclaw_device_info = opts.deviceInfo;
  }
  const linkRes = await postJson(
    `${relay}/api/link`,
    linkBody,
    fetchImpl,
  );
  if (!linkRes.ok || !linkRes.data?.token) {
    if (linkRes.status === 410) {
      await forgetStoredAgentToken({
        accountId: opts.accountId,
        stateDir,
        logger,
      });
    }
    throw new Error(
      `relay /api/link failed (status=${linkRes.status}): ${linkRes.errorDetail ?? "unknown"}`,
    );
  }
  const result: PairingResult = {
    token: linkRes.data.token,
    appId: linkRes.data.app_id,
    agentId: linkRes.data.agent_id ?? "",
    agentToken,
    via: "link",
  };
  await writeStoredCredentials(
    stateDir,
    opts.accountId,
    {
      agentToken,
      agentId: result.agentId,
      appId: result.appId,
      updatedAt: Date.now(),
    },
    logger,
  );
  logger?.info?.("link succeeded, credentials stored", {
    accountId: opts.accountId,
    appId: result.appId,
    agentId: result.agentId || "(none)",
  });
  return result;
}

/**
 * Convenience helper for upstream auth-error recovery: forgets the stored
 * agent_token so the next `pairWithRelay()` falls straight to `/api/link`.
 */
export async function forgetStoredAgentToken(opts: {
  accountId: string;
  stateDir?: string;
  logger?: PairingLogger;
}): Promise<void> {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const file = stateFilePath(stateDir, opts.accountId);
  try {
    await fs.unlink(file);
    opts.logger?.info?.("cleared stored agent_token", {
      accountId: opts.accountId,
    });
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return;
    opts.logger?.warn?.(`unlink stored credentials failed: ${String(err)}`);
  }
}

export const __internal = {
  stateFilePath,
  readStoredCredentials,
  writeStoredCredentials,
};
