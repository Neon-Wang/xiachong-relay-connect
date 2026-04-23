/**
 * EvoPaimo inbound dispatch bridge.
 *
 * Takes a raw inbound text from the relay, wraps it with the Phase 1
 * EMOTION_PROMPT, runs it through OpenClaw's `dispatchInboundReplyWithBase`,
 * then parses the resulting assistant reply (JSON with
 * `{emotion, full_text, tts_text}`) and returns an OutboundMessageFrame the
 * caller pushes back through the relay WebSocket.
 *
 * Modeled after bundled channels (e.g. `extensions/nextcloud-talk`) so that
 * inbound handling uses the same `core.channel.*` runtime helpers that
 * OpenClaw's own plugins use.
 */

import { randomUUID } from "node:crypto";

import { dispatchInboundReplyWithBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type {
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";

import { parseEmotionReply, stripThinking } from "../emotion.js";
import {
  DEFAULT_SESSION_LABEL,
  EMOTION_PROMPT,
  MAX_MESSAGE_LENGTH,
  sanitizeAgentId,
  sanitizeFromField,
  type OutboundMessageFrame,
} from "../protocol.js";

const CHANNEL_ID = "evopaimo";

export type GatewayLogSink = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export type DispatchContext = {
  accountId: string;
  sessionLabel: string;
  emotionWrapperEnabled: boolean;
  cfg: OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  log?: GatewayLogSink;
};

export type DispatchResult = {
  ok: boolean;
  frame?: OutboundMessageFrame;
  errorMessage?: string;
};

function wrapEmotionPrompt(raw: string): string {
  return EMOTION_PROMPT.replace("{message}", raw);
}

function truncateForPrompt(body: string): string {
  if (body.length <= MAX_MESSAGE_LENGTH) return body;
  return body.slice(0, MAX_MESSAGE_LENGTH);
}

/**
 * Dispatch a single inbound `message` frame through the OpenClaw agent and
 * return the resolved outbound frame (which the caller sends back to the relay).
 *
 * Returns `ok: false` with a fallback message frame when dispatch fails so the
 * caller can still respond to the user instead of silently dropping the turn.
 */
export async function dispatchInboundMessage(
  ctx: DispatchContext,
  rawContent: string,
  from: string | undefined,
): Promise<DispatchResult> {
  const {
    cfg,
    channelRuntime,
    accountId,
    sessionLabel,
    emotionWrapperEnabled,
    log,
  } = ctx;
  const sessionId = sessionLabel || DEFAULT_SESSION_LABEL;
  const trimmed = truncateForPrompt(rawContent);
  const promptBody = emotionWrapperEnabled ? wrapEmotionPrompt(trimmed) : trimmed;

  const core = { channel: channelRuntime };

  let route;
  try {
    route = channelRuntime.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer: { kind: "direct", id: sessionId },
    });
  } catch (err) {
    log?.error?.(`evopaimo: route resolution failed: ${String(err)}`);
    return { ok: false, errorMessage: `[Error] route: ${String(err)}` };
  }

  const storePath = channelRuntime.session.resolveStorePath(
    cfg.session?.store,
    { agentId: route.agentId },
  );
  const envelopeOptions = channelRuntime.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Defense in depth: even though parseInboundFrame already sanitised
  // `from`, sanitise again here so any future code path that bypasses the
  // wire parser (e.g. direct API tests, gateway-injected messages) still
  // gets safe values when the string lands in the LLM-visible envelope.
  const safeFrom = sanitizeFromField(from);
  const envelopeBody = channelRuntime.reply.formatAgentEnvelope({
    channel: "EvoPaimo",
    from: safeFrom === "unknown" ? "evopaimo:user" : `evopaimo:user:${safeFrom}`,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: promptBody,
  });

  const ctxPayload: FinalizedMsgContext = channelRuntime.reply.finalizeInboundContext({
    Body: envelopeBody,
    BodyForAgent: promptBody,
    RawBody: promptBody,
    CommandBody: promptBody,
    From: `evopaimo:${sessionId}`,
    To: `evopaimo:${sessionId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: sessionId,
    SenderName: safeFrom === "unknown" ? "evopaimo user" : `evopaimo:${safeFrom}`,
    SenderId: sessionId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: randomUUID(),
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `evopaimo:${sessionId}`,
    CommandAuthorized: false,
  });

  let bufferedText = "";
  let dispatchError: unknown = null;

  const deliver = async (payload: OutboundReplyPayload): Promise<void> => {
    if (typeof payload.text === "string" && payload.text.length > 0) {
      bufferedText += payload.text;
    }
  };

  try {
    await dispatchInboundReplyWithBase({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      route,
      storePath,
      ctxPayload,
      core,
      deliver,
      onRecordError: (err: unknown) => {
        log?.warn?.(`evopaimo: record session failed: ${String(err)}`);
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        dispatchError = err;
        log?.error?.(`evopaimo ${info.kind} reply failed: ${String(err)}`);
      },
    });
  } catch (err) {
    dispatchError = err;
    log?.error?.(`evopaimo: dispatch threw: ${String(err)}`);
  }

  if (dispatchError && !bufferedText) {
    const message = `[Error] OpenClaw 调用失败: ${String(dispatchError)}`;
    return {
      ok: false,
      errorMessage: message,
      frame: {
        type: "message",
        content: message,
        tts_text: "出错啦，稍后再试一下",
        content_type: "text",
        emotion: "sad",
        msg_id: randomUUID(),
      },
    };
  }

  const cleaned = stripThinking(bufferedText.trim());
  const { emotion, fullText, ttsText } = parseEmotionReply(cleaned);

  return {
    ok: true,
    frame: {
      type: "message",
      content: fullText,
      tts_text: ttsText,
      content_type: "text",
      emotion,
      msg_id: randomUUID(),
    },
  };
}

/**
 * Dispatch one init-request prompt step (multi-turn soul initialization).
 *
 * Mirrors Phase 1 `handle_init` in evopaimo-connect.py: each prompt is
 * dispatched serially against a `init-<agent_id>` session, and the raw
 * assistant text (after stripping `<think>` blocks) is returned so the
 * caller can send it back as `init_response`.
 */
export async function dispatchInitPrompt(
  ctx: DispatchContext,
  agentId: string,
  promptText: string,
): Promise<{ ok: boolean; content: string }> {
  const { cfg, channelRuntime, accountId, log } = ctx;
  // Sanitised once here so every downstream string (session label, store
  // path, log line, agent envelope) sees the same safe identifier — even
  // if a future caller passes raw network input.
  const safeAgentId = sanitizeAgentId(agentId);
  const initLabel = `init-${safeAgentId}`;
  const core = { channel: channelRuntime };

  let route;
  try {
    route = channelRuntime.routing.resolveAgentRoute({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      peer: { kind: "direct", id: initLabel },
    });
  } catch (err) {
    const msg = `[Error] OpenClaw 调用失败: ${String(err)}`;
    log?.error?.(`evopaimo init: route resolution failed: ${String(err)}`);
    return { ok: false, content: msg };
  }

  const storePath = channelRuntime.session.resolveStorePath(
    cfg.session?.store,
    { agentId: route.agentId },
  );
  const envelopeOptions = channelRuntime.reply.resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = channelRuntime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const envelopeBody = channelRuntime.reply.formatAgentEnvelope({
    channel: "EvoPaimo",
    from: `evopaimo:init:${safeAgentId}`,
    timestamp: Date.now(),
    previousTimestamp,
    envelope: envelopeOptions,
    body: promptText,
  });
  const ctxPayload: FinalizedMsgContext = channelRuntime.reply.finalizeInboundContext({
    Body: envelopeBody,
    BodyForAgent: promptText,
    RawBody: promptText,
    CommandBody: promptText,
    From: `evopaimo:init:${safeAgentId}`,
    To: `evopaimo:init:${safeAgentId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: initLabel,
    SenderName: "evopaimo init",
    SenderId: initLabel,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: randomUUID(),
    Timestamp: Date.now(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `evopaimo:init:${safeAgentId}`,
    CommandAuthorized: false,
  });

  let buffered = "";
  let err: unknown = null;
  const deliver = async (payload: OutboundReplyPayload): Promise<void> => {
    if (typeof payload.text === "string" && payload.text.length > 0) {
      buffered += payload.text;
    }
  };

  try {
    await dispatchInboundReplyWithBase({
      cfg,
      channel: CHANNEL_ID,
      accountId,
      route,
      storePath,
      ctxPayload,
      core,
      deliver,
      onRecordError: (e) => {
        log?.warn?.(`evopaimo init: record session failed: ${String(e)}`);
      },
      onDispatchError: (e, info) => {
        err = e;
        log?.error?.(`evopaimo init ${info.kind} failed: ${String(e)}`);
      },
    });
  } catch (e) {
    err = e;
    log?.error?.(`evopaimo init: dispatch threw: ${String(e)}`);
  }

  if (err && !buffered) {
    return { ok: false, content: `[Error] OpenClaw 调用失败: ${String(err)}` };
  }

  return { ok: true, content: stripThinking(buffered.trim()) };
}
