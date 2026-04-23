import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";

import { evopaimoGatewayAdapter } from "./runtime/account-runtime.js";
import {
  inspectAccount,
  listAccountIds,
  resolveAccount,
  type ResolvedAccount,
} from "./config.js";

// Re-export for backwards-compatibility — existing imports from src/channel.ts
// (and external code that depends on the public surface) keep working.
export type { EvoPaimoConfig, ResolvedAccount } from "./config.js";
export { inspectAccount, resolveAccount } from "./config.js";

/**
 * The EvoPaimo ChannelPlugin.
 *
 * The plugin ships its own `gateway` adapter so OpenClaw starts/stops the
 * WebSocket runtime per account as part of `openclaw gateway start`. The
 * deliberately-minimal `outbound` adapter is a no-op because every outbound
 * reply flows through the WebSocket from the per-account runtime — keeping
 * `deliveryMode: "direct"` satisfies the SDK's adapter contract without
 * introducing a second delivery path.
 */
export const evopaimoPlugin: ChannelPlugin<ResolvedAccount> = {
  id: "evopaimo",
  meta: {
    id: "evopaimo",
    label: "EvoPaimo",
    selectionLabel: "EvoPaimo (Desktop Pet Relay)",
    detailLabel: "EvoPaimo",
    docsPath: "/channels/evopaimo",
    docsLabel: "evopaimo",
    blurb: "Relay desktop pet client through the EvoPaimo Cloudflare Workers relay.",
    systemImage: "cat",
  },
  capabilities: {
    chatTypes: ["direct"],
    polls: false,
    reactions: false,
    edit: false,
    unsend: false,
    reply: true,
    media: false,
    threads: false,
    groupManagement: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  config: {
    listAccountIds,
    resolveAccount,
    inspectAccount,
    defaultAccountId: () => "default",
    isConfigured: (account) =>
      Boolean(account.relayUrl && account.linkCode && account.secret),
    unconfiguredReason: () =>
      "Configure channels.evopaimo with relayUrl, linkCode, and secret (get them from the EvoPaimo desktop client).",
  },
  // D2 (spec §5): defer DM authentication entirely to the Workers relay.
  // The relay's pairing flow (/api/link + /api/agent-auth) is our actual
  // authentication gate — anyone who can establish a WebSocket session has
  // already proven possession of `linkCode + secret`. We therefore default
  // to `open` with `allowFrom: ["*"]` so OpenClaw's DM policy check passes
  // without requiring operators to duplicate the allowlist in config.
  security: {
    resolveDmPolicy: (ctx) => {
      const policy = ctx.account.dmPolicy ?? "open";
      const configuredAllowFrom = ctx.account.allowFrom;
      const allowFrom =
        policy === "open" && (!configuredAllowFrom || configuredAllowFrom.length === 0)
          ? ["*"]
          : configuredAllowFrom;
      return {
        policy,
        allowFrom,
        allowFromPath: "channels.evopaimo.allowFrom",
        approveHint: "relay-managed (Workers link-code + secret)",
      };
    },
  },
  gateway: evopaimoGatewayAdapter,
  outbound: {
    deliveryMode: "direct",
    // All real outbound delivery happens inside the gateway-owned runtime via
    // the WebSocket. This stub exists to satisfy the adapter contract for any
    // code path that bypasses the normal inbound flow (e.g. operator-invoked
    // broadcasts); in practice it is never called.
    sendText: async () => ({
      channel: "evopaimo",
      messageId: `evopaimo-direct-${Date.now()}`,
    }),
  },
};
