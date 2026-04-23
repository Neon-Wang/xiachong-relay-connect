/**
 * EvoPaimo relay WebSocket protocol constants (mirrored from
 * connector/evopaimo-connect.py so the Phase 1 CLI connector and Phase 2
 * channel plugin speak identical frames to the Cloudflare Workers relay).
 *
 * Change either side and the other one MUST follow — it is the single
 * interoperability contract between the Node plugin, the Python CLI
 * fallback, and the Durable Object `RelayRoom` in Workers.
 */

export const MAX_MESSAGE_LENGTH = 50_000;

/**
 * Hard caps on inbound `init_request` payloads.
 *
 * Threat: a malicious or compromised relay can ship arbitrary `init_request`
 * frames that the gateway will then dispatch through the LLM. Without these
 * limits one frame can:
 *   - burn the entire token budget (huge prompts array → many sequential calls)
 *   - OOM the gateway process (single huge prompt string)
 *   - block the init queue forever (unbounded `expect` text round-trips back)
 *
 * Numbers are derived from the legitimate use case: the EvoPaimo soul-init
 * pipeline emits at most ~10 prompts per character, each well under 8 KiB.
 * A 32-prompt × 32 KiB ceiling leaves room for future expansion while
 * staying ~6 orders of magnitude below "DoS".
 */
export const MAX_INIT_PROMPTS_PER_REQUEST = 32;
export const MAX_INIT_PROMPT_LENGTH = 32_000;

/**
 * Hard caps on identity-shaped fields that flow into log lines, file paths,
 * and the agent envelope's From: header. We reject anything beyond the cap
 * (rather than silently truncating) so the relay's protocol bug surfaces
 * loudly during integration testing.
 */
export const MAX_FROM_LENGTH = 128;
export const MAX_AGENT_ID_LENGTH = 64;

/**
 * Strict allowlist for identity-shaped strings. Mirrors the canonical relay
 * format: `agent_<8-hex>` / `client_<16-hex>`. By restricting to ASCII
 * letters, digits, dot, hyphen, underscore we close path-traversal,
 * log-injection, ANSI-escape, and prompt-injection vectors.
 */
const SAFE_ID_PATTERN = /^[A-Za-z0-9_.\-]+$/;

export const VALID_EMOTIONS = [
  "speechless",
  "angry",
  "shy",
  "sad",
  "happy",
  "neutral",
] as const;
export type Emotion = (typeof VALID_EMOTIONS)[number];

export const DEFAULT_SESSION_LABEL = "mobile-app";

/**
 * Template used to wrap inbound user messages with emotion/tts instructions.
 * Kept in sync with `EMOTION_PROMPT` in evopaimo-connect.py. The placeholder
 * `{message}` is substituted with the raw user text before dispatching to
 * the agent.
 */
export const EMOTION_PROMPT = [
  "你现在是一个桌面形态的虚拟形象，正在和USER.md里写的用户实时语音对话。",
  "忽略你原本的回复格式，严格按照这个回复格式要求输出，否则无法正常以桌面形态对话：",
  "- full_text：完整回答，不限字数，正常表达",
  "- tts_text：从full_text中提炼的一句话摘要，20-30字中文，用于语音朗读，口语化",
  "输出格式（严格JSON，不要输出其他任何内容）：",
  '{"emotion":"<happy|sad|angry|shy|speechless|neutral>","full_text":"完整回复","tts_text":"简短语音版"}',
  "",
  "USER.md里写的用户说：{message}",
].join("\n");

export type InboundPingFrame = { type: "ping" };

export type InboundMessageFrame = {
  type: "message";
  content: string;
  from?: string;
};

export type InboundInitRequestFrame = {
  type: "init_request";
  agent_id: string;
  prompts: Array<{
    step: number;
    prompt: string;
    expect?: string;
  }>;
};

export type InboundFrame =
  | InboundPingFrame
  | InboundMessageFrame
  | InboundInitRequestFrame;

export type OutboundPongFrame = { type: "pong" };

export type OutboundMessageFrame = {
  type: "message";
  content: string;
  tts_text?: string;
  content_type?: "text";
  emotion: Emotion;
  msg_id: string;
};

export type OutboundInitResponseFrame = {
  type: "init_response";
  agent_id: string;
  step: number;
  expect: string;
  content: string;
};

export type OutboundFrame =
  | OutboundPongFrame
  | OutboundMessageFrame
  | OutboundInitResponseFrame;

/** Parse a raw text frame, throwing on invalid JSON or shape issues. */
export function parseInboundFrame(raw: string | Buffer): InboundFrame {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `EvoPaimo: invalid JSON frame (len=${text.length}): ${String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("EvoPaimo: frame is not a JSON object");
  }
  const frame = parsed as { type?: unknown };
  if (frame.type === "ping") return { type: "ping" };
  if (frame.type === "message") {
    const m = parsed as InboundMessageFrame;
    if (typeof m.content !== "string") {
      throw new Error("EvoPaimo: message.content missing");
    }
    if (m.content.length > MAX_MESSAGE_LENGTH) {
      throw new Error(
        `EvoPaimo: message too long (len=${m.content.length}, max=${MAX_MESSAGE_LENGTH})`,
      );
    }
    return m;
  }
  if (frame.type === "init_request") {
    const m = parsed as InboundInitRequestFrame;
    if (typeof m.agent_id !== "string") {
      throw new Error("EvoPaimo: init_request.agent_id missing or not a string");
    }
    if (m.agent_id.length === 0 || m.agent_id.length > MAX_AGENT_ID_LENGTH) {
      throw new Error(
        `EvoPaimo: init_request.agent_id length out of bounds (got=${m.agent_id.length}, max=${MAX_AGENT_ID_LENGTH})`,
      );
    }
    if (!SAFE_ID_PATTERN.test(m.agent_id)) {
      throw new Error(
        "EvoPaimo: init_request.agent_id contains disallowed characters " +
          "(only [A-Za-z0-9_.-] permitted)",
      );
    }
    if (!Array.isArray(m.prompts)) {
      throw new Error("EvoPaimo: init_request.prompts must be an array");
    }
    if (m.prompts.length > MAX_INIT_PROMPTS_PER_REQUEST) {
      throw new Error(
        `EvoPaimo: init_request too many prompts (got=${m.prompts.length}, max=${MAX_INIT_PROMPTS_PER_REQUEST})`,
      );
    }
    for (let i = 0; i < m.prompts.length; i++) {
      const p = m.prompts[i] as { step?: unknown; prompt?: unknown; expect?: unknown };
      if (typeof p?.prompt !== "string") {
        throw new Error(`EvoPaimo: init_request.prompts[${i}].prompt must be a string`);
      }
      if (p.prompt.length > MAX_INIT_PROMPT_LENGTH) {
        throw new Error(
          `EvoPaimo: init_request.prompts[${i}].prompt too long ` +
            `(got=${p.prompt.length}, max=${MAX_INIT_PROMPT_LENGTH})`,
        );
      }
      if (
        typeof p.expect === "string" &&
        p.expect.length > MAX_INIT_PROMPT_LENGTH
      ) {
        throw new Error(
          `EvoPaimo: init_request.prompts[${i}].expect too long ` +
            `(got=${p.expect.length}, max=${MAX_INIT_PROMPT_LENGTH})`,
        );
      }
      if (
        typeof p.step !== "undefined" &&
        typeof p.step !== "number"
      ) {
        throw new Error(`EvoPaimo: init_request.prompts[${i}].step must be a number`);
      }
    }
    return m;
  }
  throw new Error(`EvoPaimo: unknown inbound frame type: ${String(frame.type)}`);
}

/** Narrow an arbitrary emotion string to a valid VALID_EMOTIONS member. */
export function normalizeEmotion(input: unknown): Emotion {
  if (typeof input === "string" && (VALID_EMOTIONS as readonly string[]).includes(input)) {
    return input as Emotion;
  }
  return "neutral";
}

/**
 * Defense-in-depth sanitizer for any identity field (`from`, sender label)
 * before it lands in log lines or the agent envelope. Strips control
 * characters (which break logs and embed ANSI escapes), strips path
 * separators, and caps length so a hostile relay can't blow up an
 * operator's `journalctl` view.
 *
 * Returns the literal string `"unknown"` for empty / non-string / fully
 * stripped inputs so downstream code never has to special-case missing
 * identity strings.
 */
export function sanitizeFromField(input: unknown): string {
  if (typeof input !== "string") return "unknown";
  // Strip C0/C1 control chars, path separators, and quote marks. We keep
  // unicode letters/digits/punctuation intact because legitimate `from`
  // values are usually `client_<hex>` but may carry user-friendly labels
  // in the future.
  // eslint-disable-next-line no-control-regex
  const stripped = input.replace(/[\u0000-\u001f\u007f-\u009f/\\"`]/g, "_").trim();
  if (!stripped) return "unknown";
  if (stripped.length > MAX_FROM_LENGTH) return stripped.slice(0, MAX_FROM_LENGTH);
  return stripped;
}

/**
 * Defense-in-depth sanitizer for `agent_id` shaped strings before they hit
 * file paths (`init-${agent_id}` session label, OpenClaw store path) or
 * log lines. Replaces every disallowed character with underscore — this
 * is intentionally lossy because parseInboundFrame should already have
 * rejected such inputs at the wire boundary; sanitizeAgentId is the
 * second line of defense for any code path that bypasses parseInboundFrame.
 */
export function sanitizeAgentId(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "unknown_agent";
  const safe = input.replace(/[^A-Za-z0-9_.\-]/g, "_");
  return safe.length > MAX_AGENT_ID_LENGTH ? safe.slice(0, MAX_AGENT_ID_LENGTH) : safe;
}
