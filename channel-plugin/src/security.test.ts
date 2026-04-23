/**
 * Security regression tests for @evopaimo/channel.
 *
 * These tests model an attacker who can either (a) spoof the relay server
 * (e.g. via DNS hijack, MITM, or a user mistakenly configuring the wrong
 * relayUrl), or (b) compromise the relay itself. In both cases the
 * connector must NOT trust arbitrary data from the wire — every field
 * crossing the trust boundary must be schema-checked, length-limited,
 * and sanitized before being handed to OpenClaw.
 *
 * Each test corresponds to one numbered finding in the Phase-2 security
 * audit (`docs/specs/openclaw-hooks-integration/connector-security-audit-2026-04-22.md`).
 *
 * Add a new test here BEFORE patching the corresponding vulnerability so
 * that the test goes RED → GREEN, giving us a permanent regression guard.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_INIT_PROMPT_LENGTH,
  MAX_INIT_PROMPTS_PER_REQUEST,
  MAX_FROM_LENGTH,
  MAX_AGENT_ID_LENGTH,
  parseInboundFrame,
  sanitizeFromField,
  sanitizeAgentId,
} from "./protocol.js";
import { resolveAccount } from "./channel.js";

describe("S-1: relayUrl protocol whitelist (P0)", () => {
  // Threat: user (or attacker who can edit openclaw.json) configures an
  // http:// or ws:// relay URL. Because pairing.ts forwards the URL to
  // global fetch() and ws-client.ts hands wss:// or ws:// straight to the
  // ws library, a plain http:// URL would (1) leak the link_code+secret in
  // the clear during pairing and (2) leak the JWT token in the WS query
  // string. Anyone on the wire could then impersonate the official relay
  // and inject arbitrary inbound frames into the user's gateway.
  it("rejects http:// relayUrl (would leak credentials in cleartext)", () => {
    expect(() =>
      resolveAccount(
        {
          channels: {
            evopaimo: {
              relayUrl: "http://primo.evomap.ai",
              linkCode: "abc123",
              secret: "deadbeefcafebabe",
            },
          },
        } as never,
        null,
      ),
    ).toThrowError(/must use https:\/\//i);
  });

  it("rejects ws:// relayUrl (same MITM risk)", () => {
    expect(() =>
      resolveAccount(
        {
          channels: {
            evopaimo: {
              relayUrl: "ws://primo.evomap.ai",
              linkCode: "abc123",
              secret: "deadbeefcafebabe",
            },
          },
        } as never,
        null,
      ),
    ).toThrowError(/must use https:\/\//i);
  });

  it("rejects file:// / javascript: / arbitrary schemes", () => {
    for (const scheme of ["file:///etc/passwd", "javascript:alert(1)", "ftp://relay.example", "//bad.com"]) {
      expect(() =>
        resolveAccount(
          {
            channels: {
              evopaimo: {
                relayUrl: scheme,
                linkCode: "abc123",
                secret: "deadbeefcafebabe",
              },
            },
          } as never,
          null,
        ),
      ).toThrowError(/must use https:\/\//i);
    }
  });

  it("accepts https:// relayUrl (positive case)", () => {
    expect(() =>
      resolveAccount(
        {
          channels: {
            evopaimo: {
              relayUrl: "https://primo.evomap.ai",
              linkCode: "abc123",
              secret: "deadbeefcafebabe",
            },
          },
        } as never,
        null,
      ),
    ).not.toThrow();
  });

  it("rejects malformed URL strings entirely", () => {
    expect(() =>
      resolveAccount(
        {
          channels: {
            evopaimo: {
              relayUrl: "not a url at all",
              linkCode: "abc123",
              secret: "deadbeefcafebabe",
            },
          },
        } as never,
        null,
      ),
    ).toThrowError();
  });
});

describe("S-2: init_request prompts array length limit (P0 — DoS)", () => {
  // Threat: a malicious relay sends an init_request whose `prompts` array
  // contains 100k entries. account-runtime.ts dispatches them serially
  // through the LLM, blocking the agent for hours/days while burning
  // tokens. Without a hard cap, one frame can ruin a user's API budget.
  it("rejects init_request with > MAX_INIT_PROMPTS_PER_REQUEST prompts", () => {
    const tooMany = Array.from({ length: MAX_INIT_PROMPTS_PER_REQUEST + 1 }, (_, i) => ({
      step: i,
      prompt: "tiny",
      expect: "any",
    }));
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "agent-1",
          prompts: tooMany,
        }),
      ),
    ).toThrowError(/too many prompts/i);
  });

  it("accepts init_request at the boundary (exactly MAX_INIT_PROMPTS_PER_REQUEST)", () => {
    const atLimit = Array.from({ length: MAX_INIT_PROMPTS_PER_REQUEST }, (_, i) => ({
      step: i,
      prompt: "tiny",
      expect: "any",
    }));
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "agent-1",
          prompts: atLimit,
        }),
      ),
    ).not.toThrow();
  });
});

describe("S-3: init_request individual prompt size limit (P0 — memory exhaustion)", () => {
  // Threat: a single prompt of e.g. 200 MB string. Even before dispatch,
  // the JSON parser allocates the full string; then we wrap it with the
  // EMOTION_PROMPT (concatenation = full copy), and the LLM call may try
  // to encode and send it. One frame → process OOM.
  it("rejects init_request with a single oversized prompt", () => {
    const huge = "x".repeat(MAX_INIT_PROMPT_LENGTH + 1);
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "agent-1",
          prompts: [{ step: 0, prompt: huge, expect: "any" }],
        }),
      ),
    ).toThrowError(/prompt too long/i);
  });

  it("rejects init_request whose `expect` field is oversized", () => {
    const hugeExpect = "y".repeat(MAX_INIT_PROMPT_LENGTH + 1);
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "agent-1",
          prompts: [{ step: 0, prompt: "ok", expect: hugeExpect }],
        }),
      ),
    ).toThrowError(/expect too long|prompt too long/i);
  });
});

describe("S-4: init_request agent_id sanitization (P0/P1)", () => {
  // Threat: agent_id flows into:
  //   1. file paths via `init-${agent_id}` session label and the OpenClaw
  //      session store path resolution.
  //   2. log lines (where '\n', ANSI escapes, or huge strings can corrupt
  //      operator-readable logs).
  //   3. envelope From/To strings sent to the LLM as system context.
  // If agent_id is not constrained to a safe character set we open the
  // door to log injection, path traversal, and prompt injection via the
  // identity field.
  it("rejects init_request whose agent_id contains '..' (path traversal vector)", () => {
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "../../../etc/passwd",
          prompts: [{ step: 0, prompt: "ok", expect: "ok" }],
        }),
      ),
    ).toThrowError(/agent_id/i);
  });

  it("rejects init_request whose agent_id contains slashes / null bytes / newlines", () => {
    for (const evil of [
      "agent/with/slash",
      "agent\\with\\backslash",
      "agent\u0000null",
      "agent\nlog\ninjection",
      "agent\rcr",
      "agent\u001b[31mansi",
    ]) {
      expect(() =>
        parseInboundFrame(
          JSON.stringify({
            type: "init_request",
            agent_id: evil,
            prompts: [{ step: 0, prompt: "ok", expect: "ok" }],
          }),
        ),
      ).toThrowError(/agent_id/i);
    }
  });

  it("rejects init_request whose agent_id is oversized", () => {
    const huge = "a".repeat(MAX_AGENT_ID_LENGTH + 1);
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: huge,
          prompts: [{ step: 0, prompt: "ok", expect: "ok" }],
        }),
      ),
    ).toThrowError(/agent_id/i);
  });

  it("accepts init_request whose agent_id matches the canonical [A-Za-z0-9_.-] format", () => {
    expect(() =>
      parseInboundFrame(
        JSON.stringify({
          type: "init_request",
          agent_id: "agent_799d1999",
          prompts: [{ step: 0, prompt: "ok", expect: "ok" }],
        }),
      ),
    ).not.toThrow();
  });

  it("sanitizeAgentId strips dangerous characters (defense in depth)", () => {
    expect(sanitizeAgentId("agent_799d1999")).toBe("agent_799d1999");
    expect(sanitizeAgentId("evil/path")).toBe("evil_path");
    expect(sanitizeAgentId("evil\nlog\ninject")).toBe("evil_log_inject");
    expect(sanitizeAgentId("a".repeat(MAX_AGENT_ID_LENGTH * 2)).length).toBeLessThanOrEqual(
      MAX_AGENT_ID_LENGTH,
    );
  });
});

describe("S-5: message.from sanitization (P1)", () => {
  // Threat: `from` is interpolated directly into log lines and the
  // agent envelope's From: header (which the LLM sees verbatim). An
  // attacker can use control chars to break logs or use the "From"
  // identity to convince the LLM "this is the system administrator".
  it("strips control characters and caps length when sanitizing `from`", () => {
    expect(sanitizeFromField("client_normal-id")).toBe("client_normal-id");
    expect(sanitizeFromField("evil\nlog\ninject")).not.toContain("\n");
    expect(sanitizeFromField("evil\u0000nul")).not.toContain("\u0000");
    expect(sanitizeFromField("evil\u001b[31mansi")).not.toContain("\u001b");
    const long = "x".repeat(MAX_FROM_LENGTH * 4);
    expect(sanitizeFromField(long).length).toBeLessThanOrEqual(MAX_FROM_LENGTH);
  });

  it("returns 'unknown' for empty / non-string / overflow inputs", () => {
    expect(sanitizeFromField("")).toBe("unknown");
    expect(sanitizeFromField(undefined)).toBe("unknown");
    // @ts-expect-error testing runtime guard
    expect(sanitizeFromField(42)).toBe("unknown");
    // @ts-expect-error testing runtime guard
    expect(sanitizeFromField({ exploit: 1 })).toBe("unknown");
  });
});

describe("S-6: protocol does NOT silently accept unknown / extra payload (P1)", () => {
  // Threat: a malicious relay tries to ship extra fields hoping a future
  // refactor will start trusting them ("trojan horse" — the wire schema
  // is the contract, anything beyond it is suspect). At minimum, unknown
  // top-level types must be rejected (already covered by parseInboundFrame),
  // and the hand-off into account-runtime should never blindly forward
  // unknown frame.type values to any consumer.
  it("rejects unknown top-level type", () => {
    expect(() =>
      parseInboundFrame(
        JSON.stringify({ type: "shell_exec", cmd: "rm -rf /" }),
      ),
    ).toThrowError(/unknown inbound frame type/);
  });

  it("rejects message frames missing required content field", () => {
    expect(() =>
      parseInboundFrame(JSON.stringify({ type: "message", from: "x" })),
    ).toThrowError(/content/);
  });

  it("rejects init_request frames missing required prompts field", () => {
    expect(() =>
      parseInboundFrame(
        JSON.stringify({ type: "init_request", agent_id: "agent-1" }),
      ),
    ).toThrowError(/init_request/);
  });
});
