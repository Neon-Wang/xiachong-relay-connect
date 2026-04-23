/**
 * Pure config-resolution + URL-validation logic for the EvoPaimo channel.
 *
 * This module is deliberately a *leaf* — it does NOT import any OpenClaw
 * runtime modules. That isolation is what lets `internals.ts` re-export
 * `resolveAccount` for the standalone attack-simulation script
 * (`scripts/attack-sim.mjs`) so users / auditors can verify the *built*
 * dist/internals.js without needing the openclaw runtime present.
 *
 * If you add a new helper here, keep it pure and free of openclaw imports.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

/**
 * The slice of `openclaw.json` that this plugin owns, shaped exactly as
 * declared in `openclaw.plugin.json`'s `configSchema.evopaimo`.
 */
export type EvoPaimoConfig = {
  relayUrl?: string;
  linkCode?: string;
  secret?: string;
  sessionLabel?: string;
  emotionWrapperEnabled?: boolean;
  allowFrom?: string[];
  accounts?: Record<string, EvoPaimoConfig>;
};

/** What we resolve up-front so every adapter can reason about the same shape. */
export type ResolvedAccount = {
  accountId: string | null;
  relayUrl: string;
  linkCode: string;
  secret: string;
  sessionLabel: string;
  emotionWrapperEnabled: boolean;
  allowFrom: string[];
  dmPolicy: string | undefined;
};

export function readConfigSection(
  cfg: OpenClawConfig,
  accountId?: string | null,
): EvoPaimoConfig | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  if (!channels || typeof channels !== "object") return undefined;
  const section = channels["evopaimo"] as EvoPaimoConfig | undefined;
  if (!section || typeof section !== "object") return undefined;
  if (accountId && section.accounts && typeof section.accounts === "object") {
    const account = section.accounts[accountId];
    if (account && typeof account === "object") return account;
  }
  return section;
}

/**
 * Validate the relayUrl scheme before we hand it to fetch() / ws.
 *
 * Threat: if a user (or attacker who can edit ~/.openclaw/openclaw.json)
 * configures `http://` or `ws://`, both the pairing handshake (link_code +
 * secret) and the WebSocket auth token would be sent in cleartext. Any
 * MITM on the network can then impersonate the official relay and start
 * injecting arbitrary inbound frames into the user's local OpenClaw
 * gateway — which is exactly the attack class this plugin must prevent.
 *
 * We deliberately reject http://, ws://, file://, javascript:, data:, etc.
 * The only acceptable form is an absolute https:// URL with a host. If a
 * future deployment ever needs http:// (e.g. hermetic dev relay on
 * loopback), gate it behind an explicit `__insecureDevAllowHttp` flag —
 * never quietly accept the value here.
 */
export function validateRelayUrlScheme(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `evopaimo: channels.evopaimo.relayUrl is not a valid URL (got=${JSON.stringify(raw)}); ` +
        "must use https:// (e.g. https://primo.evomap.ai)",
    );
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `evopaimo: channels.evopaimo.relayUrl must use https:// scheme to prevent ` +
        `credential interception (got=${JSON.stringify(raw)}, scheme=${url.protocol}); ` +
        "configure a TLS-protected relay endpoint (e.g. https://primo.evomap.ai).",
    );
  }
  if (!url.host) {
    throw new Error(
      `evopaimo: channels.evopaimo.relayUrl is missing a host (got=${JSON.stringify(raw)})`,
    );
  }
}

export function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedAccount {
  const section = readConfigSection(cfg, accountId);
  const relayUrl = typeof section?.relayUrl === "string" ? section.relayUrl.trim() : "";
  const linkCode = typeof section?.linkCode === "string" ? section.linkCode.trim() : "";
  const secret = typeof section?.secret === "string" ? section.secret.trim() : "";
  if (!relayUrl) {
    throw new Error(
      "evopaimo: channels.evopaimo.relayUrl is required (e.g. https://primo.evomap.ai)",
    );
  }
  validateRelayUrlScheme(relayUrl);
  if (!linkCode || !secret) {
    throw new Error(
      "evopaimo: channels.evopaimo.linkCode and channels.evopaimo.secret are required; " +
        "obtain them from the EvoPaimo desktop client's connection panel.",
    );
  }
  return {
    accountId: accountId ?? null,
    relayUrl,
    linkCode,
    secret,
    sessionLabel:
      typeof section?.sessionLabel === "string" && section.sessionLabel
        ? section.sessionLabel
        : "mobile-app",
    emotionWrapperEnabled:
      typeof section?.emotionWrapperEnabled === "boolean"
        ? section.emotionWrapperEnabled
        : true,
    allowFrom: Array.isArray(section?.allowFrom) ? section.allowFrom : [],
    dmPolicy: undefined,
  };
}

export function inspectAccount(cfg: OpenClawConfig, accountId?: string | null) {
  const section = readConfigSection(cfg, accountId);
  const hasRelay = typeof section?.relayUrl === "string" && section.relayUrl.length > 0;
  const hasLinkCode = typeof section?.linkCode === "string" && section.linkCode.length > 0;
  const hasSecret = typeof section?.secret === "string" && section.secret.length > 0;
  const configured = hasRelay && hasLinkCode && hasSecret;
  return {
    enabled: configured,
    configured,
    relayConfigured: hasRelay,
    credentialsConfigured: hasLinkCode && hasSecret,
  };
}

export function listAccountIds(cfg: OpenClawConfig): string[] {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const section = channels?.["evopaimo"] as EvoPaimoConfig | undefined;
  if (!section) return [];
  if (section.accounts && typeof section.accounts === "object") {
    return Object.keys(section.accounts);
  }
  return ["default"];
}
