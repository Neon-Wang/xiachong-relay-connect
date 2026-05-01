import { describe, expect, it } from "vitest";
import {
  MAX_MESSAGE_LENGTH,
  normalizeEmotion,
  parseInboundFrame,
} from "./protocol.js";

describe("protocol.parseInboundFrame", () => {
  it("parses a ping frame", () => {
    expect(parseInboundFrame('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("parses a message frame", () => {
    const frame = parseInboundFrame(
      JSON.stringify({ type: "message", content: "hi", from: "user-42" }),
    );
    expect(frame.type).toBe("message");
    if (frame.type === "message") {
      expect(frame.content).toBe("hi");
      expect(frame.from).toBe("user-42");
    }
  });

  it("parses an init_request with multiple prompts", () => {
    const frame = parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent-abc",
        prompts: [
          { step: 0, prompt: "first step prompt", expect: "name" },
          { step: 1, prompt: "second", expect: "personality" },
        ],
      }),
    );
    expect(frame.type).toBe("init_request");
    if (frame.type === "init_request") {
      expect(frame.agent_id).toBe("agent-abc");
      expect(frame.prompts).toHaveLength(2);
      expect(frame.prompts[0]!.expect).toBe("name");
    }
  });

  it("rejects invalid JSON", () => {
    expect(() => parseInboundFrame("not json{")).toThrowError(/invalid JSON/);
  });

  it("rejects unknown type", () => {
    expect(() =>
      parseInboundFrame(JSON.stringify({ type: "unknown" })),
    ).toThrowError(/unknown inbound frame type/);
  });

  it("rejects oversized message content", () => {
    const huge = "x".repeat(MAX_MESSAGE_LENGTH + 1);
    expect(() =>
      parseInboundFrame(JSON.stringify({ type: "message", content: huge })),
    ).toThrowError(/message too long/);
  });

  it("rejects init_request prompts with non-string expect", () => {
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "agent-abc",
          prompts: [{ step: 0, prompt: "first step prompt", expect: { shape: "bad" } }],
        }),
      ),
    ).toThrowError(/expect must be a string/);
  });
});

describe("protocol.normalizeEmotion", () => {
  it("accepts valid emotions", () => {
    expect(normalizeEmotion("happy")).toBe("happy");
    expect(normalizeEmotion("sad")).toBe("sad");
  });

  it("defaults to neutral on unknown values", () => {
    expect(normalizeEmotion("ecstatic")).toBe("neutral");
    expect(normalizeEmotion(undefined)).toBe("neutral");
    expect(normalizeEmotion(42)).toBe("neutral");
  });
});
