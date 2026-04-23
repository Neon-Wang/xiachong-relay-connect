import { normalizeEmotion, type Emotion } from "./protocol.js";

/**
 * Parse an agent reply that SHOULD be a strict JSON
 * `{emotion, full_text, tts_text}` object (see EMOTION_PROMPT). Falls back
 * to treating the reply as free-form text when parsing fails, so the plugin
 * is graceful when the agent ignores the format hint.
 *
 * Mirrors `parse_reply` in evopaimo-connect.py.
 */
export function parseEmotionReply(raw: string): {
  emotion: Emotion;
  fullText: string;
  ttsText: string;
} {
  const cleaned = stripThinking(raw).trim();
  const match = extractFirstJsonObject(cleaned);
  if (match) {
    try {
      const obj = JSON.parse(match) as {
        emotion?: unknown;
        full_text?: unknown;
        tts_text?: unknown;
      };
      const fullText =
        typeof obj.full_text === "string" && obj.full_text
          ? obj.full_text
          : cleaned;
      const ttsText =
        typeof obj.tts_text === "string" && obj.tts_text
          ? obj.tts_text
          : truncateTts(fullText);
      return {
        emotion: normalizeEmotion(obj.emotion),
        fullText,
        ttsText,
      };
    } catch {
      // fall through
    }
  }
  return {
    emotion: "neutral",
    fullText: cleaned || raw,
    ttsText: truncateTts(cleaned || raw),
  };
}

/** Strip `<think>...</think>` blocks emitted by some reasoning models. */
export function stripThinking(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function truncateTts(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
}
