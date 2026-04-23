import { describe, expect, it } from "vitest";
import { parseEmotionReply, stripThinking } from "./emotion.js";

describe("parseEmotionReply", () => {
  it("parses strict JSON emotion output", () => {
    const raw = JSON.stringify({
      emotion: "happy",
      full_text: "长回答原文。",
      tts_text: "短 TTS。",
    });
    const out = parseEmotionReply(raw);
    expect(out.emotion).toBe("happy");
    expect(out.fullText).toBe("长回答原文。");
    expect(out.ttsText).toBe("短 TTS。");
  });

  it("normalizes unknown emotion values to neutral", () => {
    const raw = JSON.stringify({
      emotion: "excited-not-in-enum",
      full_text: "ok",
      tts_text: "ok",
    });
    expect(parseEmotionReply(raw).emotion).toBe("neutral");
  });

  it("gracefully falls back when the agent ignored the JSON format", () => {
    const out = parseEmotionReply("这就是一段纯文本回答，没有 JSON 包装。");
    expect(out.emotion).toBe("neutral");
    expect(out.fullText).toMatch(/纯文本回答/);
    expect(out.ttsText.length).toBeLessThanOrEqual(60);
  });

  it("handles reasoning models that emit <think> blocks", () => {
    const raw =
      "<think>思考过程, should be stripped</think>\n" +
      JSON.stringify({
        emotion: "sad",
        full_text: "正式回答",
        tts_text: "正式回答",
      });
    const out = parseEmotionReply(raw);
    expect(out.emotion).toBe("sad");
    expect(out.fullText).toBe("正式回答");
  });

  it("stripThinking removes nested thinking blocks", () => {
    const input = "前 <think>a</think> 中 <think>b</think> 后";
    expect(stripThinking(input)).toBe("前  中  后");
  });
});
