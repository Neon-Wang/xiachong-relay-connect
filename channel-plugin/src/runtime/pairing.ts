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
    const res = await postJson(
      `${relay}/api/agent-auth`,
      { agent_token: stored.agentToken },
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
  const linkRes = await postJson(
    `${relay}/api/link`,
    {
      link_code: opts.linkCode,
      secret: opts.secret,
      agent_token: agentToken,
    },
    fetchImpl,
  );
  if (!linkRes.ok || !linkRes.data?.token) {
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
