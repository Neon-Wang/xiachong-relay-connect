/**
 * Thin WebSocket client that mirrors Phase 1 `evopaimo-connect.py`:
 *
 *  - Client stays passive on application-level ping: it does NOT emit
 *    `{"type":"ping"}` frames itself. The relay sends `{"type":"ping"}`
 *    periodically and we reply with `{"type":"pong"}` (see Python CLI).
 *  - The underlying `ws` library handles WebSocket-protocol keep-alive
 *    frames (the caller can tune via `keepAliveIntervalMs`).
 *  - Exponential backoff reconnect on transport errors.
 *  - Hands each inbound application frame to `onFrame`.
 *  - Exposes `sendFrame` for the runtime to push outbound replies back
 *    to the relay.
 *
 * This file knows nothing about OpenClaw — `runtime/account-runtime.ts`
 * owns the agent-side wiring.
 */

import WebSocket, { type RawData } from "ws";
import {
  parseInboundFrame,
  type InboundFrame,
  type OutboundFrame,
} from "../protocol.js";

/**
 * Application-defined close codes emitted by the relay (mirror of
 * `workers/src/relay/protocol.ts` → `WS_CLOSE`). We only surface the
 * terminal ones the plugin should react to — everything else falls
 * through to the generic reconnect path.
 */
export const WS_CLOSE_UNBOUND = 4004;

export type WsClientLogger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Resolve a fresh short-lived relay auth token. The runtime performs the
 * `/api/link` or `/api/agent-auth` exchange and hands us a token we embed in
 * the WebSocket query string (`?token=`). We ask for a new token right before
 * every connection attempt because the relay treats them as single-use.
 *
 * If resolution fails (e.g. network outage, relay down), the promise should
 * reject — the caller schedules the next reconnect via exponential backoff.
 */
export type TokenResolver = (opts: {
  reason: "initial" | "reconnect" | "auth-rejected";
}) => Promise<string>;

export type WsClientOptions = {
  accountId: string;
  relayUrl: string;
  tokenResolver: TokenResolver;
  /** WebSocket-protocol-level ping interval (handled by `ws` lib). @default 30000 */
  keepAliveIntervalMs?: number;
  /** @default 1000 */
  reconnectBaseMs?: number;
  /** @default 60000 */
  reconnectMaxMs?: number;
  logger: WsClientLogger;
  onFrame: (frame: InboundFrame) => Promise<void> | void;
  /** Called after the socket is fully open. */
  onReady?: () => void;
  /** Called when the socket transitions to closed/disconnected (before reconnect attempts). */
  onDisconnect?: (info: { code?: number; reason?: string; authRejected?: boolean }) => void;
};

function buildRelayWsUrl(relayUrl: string, token: string): string {
  const normalized = relayUrl.trim().replace(/\/+$/, "");
  const wsBase = normalized
    .replace(/^http:\/\//i, "ws://")
    .replace(/^https:\/\//i, "wss://");
  const u = new URL(`${wsBase}/ws/openclaw`);
  u.searchParams.set("token", token);
  return u.toString();
}

export class RelayWsClient {
  readonly accountId: string;
  private readonly relayUrl: string;
  private readonly tokenResolver: TokenResolver;
  private readonly keepAliveIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly logger: WsClientLogger;
  private readonly onFrame: (frame: InboundFrame) => Promise<void> | void;
  private readonly onReady?: () => void;
  private readonly onDisconnect?: (info: { code?: number; reason?: string; authRejected?: boolean }) => void;

  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  /**
   * Last transport error observed on the currently-opening socket. We use
   * this to decide whether a `close` event means "handshake rejected" (→
   * probably 401) or "clean disconnect". Reset to `null` on successful open.
   */
  private lastHandshakeError: Error | null = null;
  private isFirstConnect = true;

  constructor(opts: WsClientOptions) {
    this.accountId = opts.accountId;
    this.relayUrl = opts.relayUrl;
    this.tokenResolver = opts.tokenResolver;
    this.keepAliveIntervalMs = opts.keepAliveIntervalMs ?? 30_000;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60_000;
    this.logger = opts.logger;
    this.onFrame = opts.onFrame;
    this.onReady = opts.onReady;
    this.onDisconnect = opts.onDisconnect;
  }

  start(): void {
    if (this.stopped) return;
    void this.openSocket();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, "plugin shutdown");
      } else {
        ws.terminate();
      }
    } catch (err) {
      this.logger.warn("close failed", {
        accountId: this.accountId,
        err: String(err),
      });
    }
  }

  /** Send one outbound frame to the relay (if the socket is open). */
  sendFrame(frame: OutboundFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.logger.warn("drop outbound frame: socket not open", {
        accountId: this.accountId,
        type: frame.type,
        readyState: ws?.readyState,
      });
      return false;
    }
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.logger.error("send failed", {
        accountId: this.accountId,
        err: String(err),
        type: frame.type,
      });
      return false;
    }
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private async openSocket(): Promise<void> {
    let token: string;
    try {
      const reason = this.isFirstConnect
        ? ("initial" as const)
        : this.lastHandshakeError && isAuthFailure(this.lastHandshakeError)
          ? ("auth-rejected" as const)
          : ("reconnect" as const);
      token = await this.tokenResolver({ reason });
    } catch (err) {
      this.logger.error("token resolution failed", {
        accountId: this.accountId,
        err: String(err),
      });
      this.ws = null;
      this.scheduleReconnect();
      return;
    }
    this.isFirstConnect = false;
    this.lastHandshakeError = null;

    const url = buildRelayWsUrl(this.relayUrl, token);
    this.logger.info("connecting", {
      accountId: this.accountId,
      relayUrl: this.relayUrl,
    });

    const ws = new WebSocket(url, {
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    const hbTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          /* best effort */
        }
      }
    }, this.keepAliveIntervalMs);
    hbTimer.unref?.();

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.lastHandshakeError = null;
      this.logger.info("open", { accountId: this.accountId });
      this.onReady?.();
    });
    ws.on("message", (data: RawData) => this.handleMessage(data));
    ws.on("error", (err: Error) => {
      this.lastHandshakeError = err;
      this.logger.warn("ws error", {
        accountId: this.accountId,
        err: String(err),
      });
    });
    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString("utf8") || "";
      clearInterval(hbTimer);
      const authRejected = this.lastHandshakeError
        ? isAuthFailure(this.lastHandshakeError)
        : false;
      this.logger.warn("ws closed", {
        accountId: this.accountId,
        code,
        reason,
        authRejected: authRejected || undefined,
      });
      this.onClose(code, reason, authRejected);
    });
  }

  private handleMessage(data: RawData): void {
    let frame: InboundFrame;
    try {
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof Buffer
          ? data.toString("utf8")
          : String(data);
      frame = parseInboundFrame(raw);
    } catch (err) {
      this.logger.warn("frame parse failed", {
        accountId: this.accountId,
        err: String(err),
      });
      return;
    }

    if (frame.type === "ping") {
      this.sendFrame({ type: "pong" });
      return;
    }

    void (async () => {
      try {
        await this.onFrame(frame);
      } catch (err) {
        this.logger.error("onFrame handler failed", {
          accountId: this.accountId,
          err: String(err),
          type: frame.type,
        });
      }
    })();
  }

  private onClose(code: number, reason: string, authRejected: boolean): void {
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.removeAllListeners();
    } catch {
      /* best effort */
    }
    this.onDisconnect?.({ code, reason, authRejected });
    if (this.stopped) return;

    // Terminal close: server says this device's linkCode is no longer
    // valid (user unbound via dashboard / admin unbind). Do NOT reconnect —
    // the stored linkCode is dead and retrying in a tight loop would just
    // burn CPU/bandwidth for no recovery path. Human intervention required
    // (re-run `openclaw plugins install` with fresh credentials). We also
    // promote the log level so this shows up in casual `journalctl` tails.
    if (code === WS_CLOSE_UNBOUND) {
      this.logger.error(
        "relay unbound this device — credentials are no longer valid, reconnect suppressed",
        {
          accountId: this.accountId,
          code,
          reason,
          actionRequired:
            "re-pair OpenClaw with fresh link_code/secret from website",
        },
      );
      this.stopped = true;
      this.clearReconnectTimer();
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const attempt = this.reconnectAttempt++;
    const base = Math.min(
      this.reconnectBaseMs * Math.pow(2, attempt),
      this.reconnectMaxMs,
    );
    const jitter = Math.floor(Math.random() * 1_000);
    const delay = base + jitter;
    this.logger.info("reconnect scheduled", {
      accountId: this.accountId,
      attempt,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

export { buildRelayWsUrl };

/**
 * Heuristic: "does this error indicate an auth rejection during the HTTP
 * upgrade handshake?" We mirror the `ws` library's error string format,
 * e.g. `Error: Unexpected server response: 401`.
 */
function isAuthFailure(err: Error): boolean {
  const msg = err.message ?? String(err);
  return /unexpected server response:\s*(401|403)/i.test(msg);
}
