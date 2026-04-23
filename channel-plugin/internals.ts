/**
 * Internals entry — re-exports the pure validation/sanitization primitives
 * and config resolver so that downstream tooling (notably the attack
 * simulation script under `scripts/attack-sim.mjs`) can verify the *built*
 * dist artifact, not just the source. Stable from 0.1.1 onward.
 *
 * This is intentionally a narrow, security-focused surface area:
 *   - parseInboundFrame / outbound builders for wire-protocol fuzzing
 *   - sanitizeFromField / sanitizeAgentId for sanitizer regression checks
 *   - resolveAccount for relayUrl scheme-validation regression checks
 *   - the public MAX_* constants so test code can drive the exact limit
 */

export {
  parseInboundFrame,
  sanitizeFromField,
  sanitizeAgentId,
  normalizeEmotion,
  MAX_MESSAGE_LENGTH,
  MAX_INIT_PROMPTS_PER_REQUEST,
  MAX_INIT_PROMPT_LENGTH,
  MAX_FROM_LENGTH,
  MAX_AGENT_ID_LENGTH,
} from "./src/protocol.js";

export { resolveAccount, validateRelayUrlScheme } from "./src/config.js";
