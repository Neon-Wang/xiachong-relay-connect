#!/usr/bin/env node
// Attack simulator for the @evopaimo/channel published artifact.
// Runs all P0/P1 attack scenarios against the *built* dist/index.js so
// we are testing the exact code that ships to users, not just the source.
//
// Usage:
//   node scripts/attack-sim.mjs
//
// Exit code 0 = every attack was correctly rejected.
// Exit code != 0 = at least one attack got past the connector.

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve which built artifact to attack:
//   1. EVOPAIMO_DIST env var (absolute path to dist/internals.js or its dir)
//   2. ../dist/internals.js relative to this script (default for repo dev)
let distPath;
if (process.env.EVOPAIMO_DIST) {
  const candidate = process.env.EVOPAIMO_DIST;
  distPath = candidate.endsWith(".js")
    ? candidate
    : resolve(candidate, "internals.js");
} else {
  distPath = resolve(__dirname, "..", "dist", "internals.js");
}

const dist = await import(distPath);
const {
  parseInboundFrame,
  sanitizeFromField,
  sanitizeAgentId,
  resolveAccount,
  MAX_INIT_PROMPTS_PER_REQUEST,
  MAX_INIT_PROMPT_LENGTH,
  MAX_FROM_LENGTH,
  MAX_AGENT_ID_LENGTH,
} = dist;

if (!parseInboundFrame || !resolveAccount) {
  console.error("FATAL: dist exports missing — rebuild with `pnpm run build`");
  process.exit(2);
}

/** @type {{ name: string, run: () => void }[]} */
const cases = [];

function expectThrow(name, fn, includes) {
  cases.push({
    name,
    run() {
      let err;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      if (!err) {
        throw new Error(`attack succeeded: ${name} did NOT throw`);
      }
      if (includes && !String(err.message).includes(includes)) {
        throw new Error(
          `attack rejected but with wrong reason: ${name}\n` +
            `  expected message to include: ${includes}\n` +
            `  got: ${err.message}`,
        );
      }
    },
  });
}

function expectEqual(name, fn, expected) {
  cases.push({
    name,
    run() {
      const actual = fn();
      if (actual !== expected) {
        throw new Error(
          `behavior drift: ${name}\n  expected=${JSON.stringify(expected)}\n  actual=${JSON.stringify(actual)}`,
        );
      }
    },
  });
}

// ── A. relayUrl scheme attacks ─────────────────────────────────────────────
expectThrow(
  "A1. http:// relay rejected at startup (cleartext credential interception)",
  () => resolveAccount({ channels: { evopaimo: { relayUrl: "http://attacker.evil/" } } }),
  "https://",
);
expectThrow(
  "A2. ws:// relay rejected (skip TLS entirely)",
  () => resolveAccount({ channels: { evopaimo: { relayUrl: "ws://attacker.evil/" } } }),
  "https://",
);
expectThrow(
  "A3. file:// relay rejected (local path injection)",
  () => resolveAccount({ channels: { evopaimo: { relayUrl: "file:///etc/passwd" } } }),
  "https://",
);
expectThrow(
  "A4. javascript: relay rejected",
  () => resolveAccount({ channels: { evopaimo: { relayUrl: "javascript:alert(1)" } } }),
  "https://",
);
expectThrow(
  "A5. malformed URL rejected with clear error",
  () => resolveAccount({ channels: { evopaimo: { relayUrl: "not a url" } } }),
  "valid URL",
);

// ── B. init_request flood / DoS attacks ────────────────────────────────────
expectThrow(
  "B1. init_request with prompts.length > 32 rejected (DoS via prompt flood)",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent_attack",
        prompts: Array.from({ length: MAX_INIT_PROMPTS_PER_REQUEST + 1 }, (_, i) => ({
          step: i,
          prompt: "x",
        })),
      }),
    ),
  "too many prompts",
);
expectThrow(
  "B2. single oversized prompt rejected (memory exhaustion)",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent_attack",
        prompts: [{ step: 0, prompt: "A".repeat(MAX_INIT_PROMPT_LENGTH + 1) }],
      }),
    ),
  "prompt too long",
);
expectThrow(
  "B3. oversized expect rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent_attack",
        prompts: [{ step: 0, prompt: "x", expect: "B".repeat(MAX_INIT_PROMPT_LENGTH + 1) }],
      }),
    ),
  "expect too long",
);
expectThrow(
  "B4. prompts not an array rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent_attack",
        prompts: "not-an-array",
      }),
    ),
  "must be an array",
);
expectThrow(
  "B5. prompt with non-string content rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent_attack",
        prompts: [{ step: 0, prompt: { evil: true } }],
      }),
    ),
  "must be a string",
);

// ── C. agent_id injection attacks ──────────────────────────────────────────
expectThrow(
  "C1. agent_id with newline (log injection) rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "alice\n[FAKE LOG]",
        prompts: [{ step: 0, prompt: "x" }],
      }),
    ),
  "disallowed characters",
);
expectThrow(
  "C2. agent_id with path traversal rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "../../etc/passwd",
        prompts: [{ step: 0, prompt: "x" }],
      }),
    ),
  "disallowed characters",
);
expectThrow(
  "C3. agent_id with shell metacharacters rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "alice; rm -rf /",
        prompts: [{ step: 0, prompt: "x" }],
      }),
    ),
  "disallowed characters",
);
expectThrow(
  "C4. agent_id > 64 chars rejected (label/path overflow)",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "a".repeat(MAX_AGENT_ID_LENGTH + 1),
        prompts: [{ step: 0, prompt: "x" }],
      }),
    ),
  "out of bounds",
);
expectThrow(
  "C5. empty agent_id rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "",
        prompts: [{ step: 0, prompt: "x" }],
      }),
    ),
  "out of bounds",
);
expectThrow(
  "C6. agent_id missing rejected",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        prompts: [{ step: 0, prompt: "x" }],
      }),
    ),
  "missing or not a string",
);

// ── D. defense-in-depth sanitizers ─────────────────────────────────────────
expectEqual(
  "D1. sanitizeFromField strips control chars + path separators",
  () => sanitizeFromField("ali\nce/../bo\u0000b"),
  "ali_ce_.._bo_b",
);
expectEqual(
  "D2. sanitizeFromField empty/non-string → 'unknown'",
  () => sanitizeFromField(undefined),
  "unknown",
);
expectEqual(
  "D3. sanitizeFromField caps oversized input",
  () => sanitizeFromField("a".repeat(MAX_FROM_LENGTH + 200)).length === MAX_FROM_LENGTH,
  true,
);
expectEqual(
  "D4. sanitizeAgentId reduces unsafe chars to underscores",
  () => sanitizeAgentId("../etc/passwd"),
  ".._etc_passwd",
);
expectEqual(
  "D5. sanitizeAgentId empty → 'unknown_agent'",
  () => sanitizeAgentId(""),
  "unknown_agent",
);

// ── E. message frame attacks ───────────────────────────────────────────────
expectThrow(
  "E1. message with content > 50000 rejected (memory exhaustion)",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "message",
        from: "alice",
        content: "x".repeat(50_001),
      }),
    ),
  "too long",
);
expectThrow(
  "E2. unknown frame type rejected (no execute_shell, no eval, no run)",
  () => parseInboundFrame(JSON.stringify({ type: "execute_shell", cmd: "rm -rf /" })),
  "unknown inbound frame type",
);
expectThrow(
  "E3. invalid JSON rejected",
  () => parseInboundFrame("{not json"),
  "JSON",
);

// ── F. ensure normal happy path still works ────────────────────────────────
expectEqual(
  "F1. valid init_request still parses",
  () =>
    parseInboundFrame(
      JSON.stringify({
        type: "init_request",
        agent_id: "agent_799d1999",
        prompts: [{ step: 0, prompt: "say hi" }],
      }),
    ).type,
  "init_request",
);
expectEqual(
  "F2. valid message still parses",
  () =>
    parseInboundFrame(
      JSON.stringify({ type: "message", from: "alice", content: "hello world" }),
    ).type,
  "message",
);
expectEqual(
  "F3. valid relayUrl accepted (https://primo.evomap.ai)",
  () =>
    resolveAccount({
      channels: {
        evopaimo: {
          relayUrl: "https://primo.evomap.ai",
          linkCode: "DUMMY1",
          secret: "0".repeat(64),
        },
      },
    }).relayUrl,
  "https://primo.evomap.ai",
);

let pass = 0;
let fail = 0;
const failures = [];
for (const c of cases) {
  try {
    c.run();
    pass++;
    console.log(`  PASS  ${c.name}`);
  } catch (e) {
    fail++;
    failures.push({ name: c.name, error: e.message });
    console.log(`  FAIL  ${c.name}\n        ${e.message}`);
  }
}

console.log("\n" + "=".repeat(72));
console.log(`Attack simulation complete: ${pass} blocked / ${cases.length} attacks attempted`);
if (fail > 0) {
  console.log(`FAILED ${fail} — connector did NOT block these attacks:`);
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log("All attacks rejected by connector hardening. ✓");
process.exit(0);
