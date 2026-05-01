/**
 * Per-account runtime: a small orchestrator that owns the WebSocket client
 * lifecycle and bridges every inbound relay frame into OpenClaw's agent
 * dispatcher.
 *
 * OpenClaw's gateway invokes `startAccount` exactly once when an account
 * becomes active (on `openclaw gateway start` or when the account is enabled
 * at runtime), and calls `stopAccount` on clean shutdown. The runtime keeps
 * at most one WebSocket per (channelId, accountId) pair.
 *
 * Outbound frames produced by the OpenClaw agent are sent back to the relay
 * as `OutboundMessageFrame` / `OutboundInitResponseFrame`. `init_request`
 * prompts are handled serially to preserve Phase 1 CLI semantics.
 */

import { createRequire } from "node:module";

import type {
  ChannelAccountSnapshot,
  ChannelGatewayContext,
} from "openclaw/plugin-sdk/channel-contract";

import type { ResolvedAccount } from "../channel.js";
import {
  sanitizeAgentId,
  sanitizeFromField,
  type InboundFrame,
  type OutboundInitResponseFrame,
  type OutboundMessageFrame,
} from "../protocol.js";
import {
  dispatchInboundMessage,
  dispatchInitPrompt,
  type DispatchContext,
  type GatewayLogSink,
} from "./dispatch.js";
import {
  buildDeviceInfo,
  forgetStoredAgentToken,
  pairWithRelay,
  type DeviceInfo,
  type PairingLogger,
} from "./pairing.js";
import {
  RelayWsClient,
  WS_CLOSE_UNBOUND,
  type TokenResolver,
  type WsClientLogger,
} from "./ws-client.js";

const CHANNEL_ID = "evopaimo";

/**
 * Best-effort read of the plugin version from the bundled `package.json`.
 *
 * Runs at module load so we only pay the disk hit once per gateway
 * process. If anything goes wrong (missing file in an unusual bundler
 * layout, JSON corruption), we fall through to undefined; `buildDeviceInfo`
 * treats undefined as "don't send this field" rather than sending an
 * empty string.
 *
 * We avoid a dynamic `import("../../package.json")` because tsup
 * bundles ESM to a single file and mixing JSON imports with that
 * pipeline causes half the version metadata to land in the wrong
 * chunk. Resolving relative to `import.meta.url` → the dist file's
 * location → `../package.json` is robust across the published layout
 * (`dist/index.js` + `package.json` siblings).
 */
function readPluginVersion(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req("../../package.json") as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

const PLUGIN_VERSION = readPluginVersion();

function currentDeviceInfo(): DeviceInfo {
  return buildDeviceInfo(PLUGIN_VERSION);
}

/** Registry of active per-(account) runtimes keyed by accountId. */
const REGISTRY = new Map<string, EvoPaimoAccountRuntime>();

function adaptLogSink(log: ChannelGatewayContext<ResolvedAccount>["log"]): GatewayLogSink {
  return {
    info: (message) => log?.info?.(message),
    warn: (message) => log?.warn?.(message),
    error: (message) => log?.error?.(message),
    debug: (message) => log?.debug?.(message),
  };
}

function adaptWsLogger(log: ChannelGatewayContext<ResolvedAccount>["log"]): WsClientLogger {
  return {
    debug: (message, meta) => log?.debug?.(formatMeta(message, meta)),
    info: (message, meta) => log?.info?.(formatMeta(message, meta)),
    warn: (message, meta) => log?.warn?.(formatMeta(message, meta)),
    error: (message, meta) => log?.error?.(formatMeta(message, meta)),
  };
}

function adaptPairingLogger(log: ChannelGatewayContext<ResolvedAccount>["log"]): PairingLogger {
  return {
    debug: (message, meta) => log?.debug?.(formatMeta(`pairing: ${message}`, meta)),
    info: (message, meta) => log?.info?.(formatMeta(`pairing: ${message}`, meta)),
    warn: (message, meta) => log?.warn?.(formatMeta(`pairing: ${message}`, meta)),
    error: (message, meta) => log?.error?.(formatMeta(`pairing: ${message}`, meta)),
  };
}

function formatMeta(message: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return `evopaimo-ws: ${message}`;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    parts.push(`${k}=${safeStringify(v)}`);
  }
  return `evopaimo-ws: ${message} ${parts.join(" ")}`;
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || typeof v === "undefined") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Runtime for one configured account. Instantiated by `startAccount`.
 *
 * The gateway's channel lifecycle expects `startAccount` to return a promise
 * that stays PENDING for the full lifetime of the account — only resolving
 * when the account is stopped (either by a `stopAccount` call or a fatal
 * error). Resolving early is interpreted as "the account exited" and
 * triggers auto-reconnect / restart logic.
 *
 * We therefore hold a `donePromise` that we resolve from `stop()` or when a
 * fatal/non-recoverable error bubbles up.
 */
class EvoPaimoAccountRuntime {
  readonly accountId: string;
  private readonly dispatchCtx: DispatchContext;
  private readonly client: RelayWsClient;
  private readonly setStatus: (next: ChannelAccountSnapshot) => void;
  private readonly getStatus: () => ChannelAccountSnapshot;
  private initQueue: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly donePromise: Promise<void>;
  private resolveDone: () => void = () => undefined;

  constructor(ctx: ChannelGatewayContext<ResolvedAccount>) {
    this.accountId = ctx.accountId;
    this.donePromise = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
    const wsLogger = adaptWsLogger(ctx.log);
    const pairingLogger = adaptPairingLogger(ctx.log);
    const logSink = adaptLogSink(ctx.log);

    if (!ctx.channelRuntime) {
      throw new Error(
        "evopaimo: channelRuntime is unavailable (requires OpenClaw Plugin SDK >= 2026.2.19).",
      );
    }

    this.dispatchCtx = {
      accountId: ctx.accountId,
      sessionLabel: ctx.account.sessionLabel,
      emotionWrapperEnabled: ctx.account.emotionWrapperEnabled,
      cfg: ctx.cfg,
      channelRuntime: ctx.channelRuntime,
      log: logSink,
    };
    this.setStatus = ctx.setStatus;
    this.getStatus = ctx.getStatus;

    const tokenResolver: TokenResolver = async ({ reason }) => {
      if (reason === "auth-rejected") {
        await forgetStoredAgentToken({
          accountId: ctx.accountId,
          logger: pairingLogger,
        });
      }
      const result = await pairWithRelay({
        accountId: ctx.accountId,
        relayUrl: ctx.account.relayUrl,
        linkCode: ctx.account.linkCode,
        secret: ctx.account.secret,
        logger: pairingLogger,
        deviceInfo: currentDeviceInfo(),
      });
      ctx.log?.info?.(
        `evopaimo: paired via ${result.via} (appId=${result.appId || "?"} agentId=${result.agentId || "?"})`,
      );
      return result.token;
    };

    this.client = new RelayWsClient({
      accountId: ctx.accountId,
      relayUrl: ctx.account.relayUrl,
      tokenResolver,
      logger: wsLogger,
      onFrame: (frame) => this.handleFrame(frame),
      onReady: () => this.onReady(),
      onDisconnect: (info) => this.onDisconnect(info),
    });

    ctx.abortSignal.addEventListener(
      "abort",
      () => {
        void this.stop();
      },
      { once: true },
    );
  }

  /**
   * Returns a promise that resolves only when the account is stopped. The
   * gateway uses this to know when to schedule restarts.
   */
  run(): Promise<void> {
    this.updateStatus({ running: true, connected: false, lastStartAt: Date.now() });
    this.client.start();
    return this.donePromise;
  }

  /** Exposed so a second `startAccount` call can await the same lifetime. */
  get donePromiseForGateway(): Promise<void> {
    return this.donePromise;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.client.stop();
    this.updateStatus({
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    });
    REGISTRY.delete(this.accountId);
    this.resolveDone();
  }

  private onReady(): void {
    this.updateStatus({
      running: true,
      connected: true,
      lastConnectedAt: Date.now(),
      lastError: null,
      healthState: "healthy",
    });
  }

  private onDisconnect(info: {
    code?: number;
    reason?: string;
    authRejected?: boolean;
  }): void {
    if (info.code === WS_CLOSE_UNBOUND) {
      void forgetStoredAgentToken({
        accountId: this.accountId,
      });
      this.updateStatus({
        running: false,
        connected: false,
        lastStopAt: Date.now(),
        lastError: info.reason || "device unbound",
        healthState: "unbound",
        lastDisconnect: {
          at: Date.now(),
          status: info.code,
          error: info.reason || "device unbound",
        },
      });
      REGISTRY.delete(this.accountId);
      this.resolveDone();
      return;
    }

    const tag = info.authRejected ? "auth-rejected" : "disconnected";
    const lastDisconnect = {
      at: Date.now(),
      status: info.code,
      error: info.reason ?? tag,
    };
    this.updateStatus({
      connected: false,
      lastDisconnect,
      healthState: info.authRejected ? "auth-error" : "reconnecting",
    });
  }

  private updateStatus(patch: Partial<ChannelAccountSnapshot>): void {
    const prev = this.getStatus();
    const next: ChannelAccountSnapshot = {
      ...prev,
      ...patch,
      accountId: prev?.accountId ?? this.accountId,
      lastEventAt: Date.now(),
    };
    try {
      this.setStatus(next);
    } catch {
      /* status sink is best-effort */
    }
  }

  private async handleFrame(frame: InboundFrame): Promise<void> {
    if (this.stopped) return;
    if (frame.type === "ping") {
      this.dispatchCtx.log?.debug?.(`evopaimo: <- ping (accountId=${this.accountId})`);
      return;
    }
    // Log ANY non-ping inbound so operators can observe the wire without enabling
    // ws-client debug. Only logs the frame type + a short content preview so we
    // don't spill message bodies at INFO level.
    if (frame.type === "message") {
      const safeFrom = sanitizeFromField(frame.from);
      const preview = frame.content
        .slice(0, 80)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ");
      this.dispatchCtx.log?.info?.(
        `evopaimo: <- message from=${safeFrom} content="${preview}${frame.content.length > 80 ? "…" : ""}"`,
      );
      await this.handleMessage(frame.content, safeFrom);
      return;
    }
    if (frame.type === "init_request") {
      const safeAgent = sanitizeAgentId(frame.agent_id);
      this.dispatchCtx.log?.info?.(
        `evopaimo: <- init_request agentId=${safeAgent} steps=${frame.prompts.length}`,
      );
      this.enqueueInit(safeAgent, frame.prompts);
      return;
    }
    this.dispatchCtx.log?.warn?.(
      `evopaimo: ignored unknown inbound frame type=${String((frame as { type: unknown }).type)}`,
    );
  }

  private async handleMessage(content: string, from: string | undefined): Promise<void> {
    try {
      const result = await dispatchInboundMessage(this.dispatchCtx, content, from);
      if (result.frame) {
        this.dispatchCtx.log?.info?.(
          `evopaimo: -> message emotion=${result.frame.emotion} tts_len=${result.frame.tts_text?.length ?? 0} content_len=${result.frame.content.length}`,
        );
        this.sendOutbound(result.frame);
      } else if (result.errorMessage) {
        this.dispatchCtx.log?.error?.(
          `evopaimo: no reply frame produced (error=${result.errorMessage})`,
        );
      }
    } catch (err) {
      this.dispatchCtx.log?.error?.(`evopaimo: dispatch crashed: ${String(err)}`);
    }
  }

  /** Serialize init prompts so every step observes the previous step's memory. */
  private enqueueInit(
    agentId: string,
    prompts: Array<{ step: number; prompt: string; expect?: string }>,
  ): void {
    this.initQueue = this.initQueue
      .catch(() => undefined)
      .then(async () => {
        for (const p of prompts) {
          if (this.stopped) return;
          if (typeof p.prompt !== "string" || !p.prompt.trim()) continue;
          const step = typeof p.step === "number" ? p.step : 0;
          const expect = typeof p.expect === "string" ? p.expect : "";
          try {
            const res = await dispatchInitPrompt(this.dispatchCtx, agentId, p.prompt);
            const frame: OutboundInitResponseFrame = {
              type: "init_response",
              agent_id: agentId,
              step,
              expect,
              content: res.content,
            };
            this.sendOutbound(frame);
          } catch (err) {
            this.dispatchCtx.log?.error?.(
              `evopaimo init step ${step} failed: ${String(err)}`,
            );
            this.sendOutbound({
              type: "init_response",
              agent_id: agentId,
              step,
              expect,
              content: `[Error] OpenClaw 调用失败: ${String(err)}`,
            });
          }
        }
      });
  }

  private sendOutbound(frame: OutboundMessageFrame | OutboundInitResponseFrame): void {
    const ok = this.client.sendFrame(frame);
    if (!ok) {
      this.dispatchCtx.log?.warn?.(
        `evopaimo: dropped outbound frame (type=${frame.type}) — socket not open`,
      );
    }
  }
}

/** Look up whether an account is currently running (primarily for tests). */
export function getAccountRuntime(accountId: string): EvoPaimoAccountRuntime | undefined {
  return REGISTRY.get(accountId);
}

/**
 * Gateway-facing runner. Constructs the per-account runtime and returns the
 * long-lived promise that stays pending until the account is stopped — this
 * is what prevents the gateway's restart loop from firing while the channel
 * is happily connected.
 */
export async function runAccount(
  ctx: ChannelGatewayContext<ResolvedAccount>,
): Promise<void> {
  const existing = REGISTRY.get(ctx.accountId);
  if (existing) {
    ctx.log?.warn?.(
      `evopaimo: startAccount called for ${ctx.accountId} which is already running; awaiting its existing run promise.`,
    );
    await existing.donePromiseForGateway;
    return;
  }
  const runtime = new EvoPaimoAccountRuntime(ctx);
  REGISTRY.set(ctx.accountId, runtime);
  ctx.log?.info?.(
    `evopaimo: started account ${ctx.accountId} (relay=${ctx.account.relayUrl}, session=${ctx.account.sessionLabel})`,
  );
  await runtime.run();
  ctx.log?.info?.(`evopaimo: account ${ctx.accountId} run() resolved`);
}

export async function stopAccountRuntime(
  ctx: ChannelGatewayContext<ResolvedAccount>,
): Promise<void> {
  const runtime = REGISTRY.get(ctx.accountId);
  if (!runtime) {
    ctx.log?.info?.(`evopaimo: stopAccount for ${ctx.accountId} — no runtime recorded.`);
    return;
  }
  await runtime.stop();
  ctx.log?.info?.(`evopaimo: stopped account ${ctx.accountId}`);
}

export const evopaimoGatewayAdapter = {
  channelId: CHANNEL_ID,
  async startAccount(ctx: ChannelGatewayContext<ResolvedAccount>) {
    await runAccount(ctx);
  },
  async stopAccount(ctx: ChannelGatewayContext<ResolvedAccount>) {
    await stopAccountRuntime(ctx);
  },
};
