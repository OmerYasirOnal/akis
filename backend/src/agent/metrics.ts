import type { AgentMetrics } from '@akis/shared'

/**
 * The SINGLE honesty choke point for per-agent cost metrics. Every agent routes its
 * agent_end metrics through here, so the rules below are enforced in exactly one tested place.
 *
 * - durationMs is the REAL wall-clock activation time: Date.now() now minus `startedAt`
 *   (captured at the agent's start). It is NEVER derived from event.ts — nextTs() is a
 *   deterministic counter, not wall-clock ms (see events/clock.ts).
 * - toolCalls is the REAL count of tool_call events the agent emitted in this activation.
 * - usage is treated as ABSENT (the `usage` key is OMITTED entirely) when it is undefined
 *   OR when BOTH inTokens and outTokens are 0. The both-zero collapse is the MockProvider
 *   honesty fix: MockProvider (the default keyless/demo AND default test provider) returns
 *   usage:{inTokens:0,outTokens:0} on every branch — attaching it would render "0 tok" on
 *   nearly every demo run, a fabricated-looking real zero. Collapsing {0,0}→absent renders
 *   an honest "—" instead, and ALSO catches any other provider/round that legitimately emits
 *   a zero-usage block (e.g. a Gemini round). A genuine 0/0 measurement is not meaningful to
 *   surface anyway, so this is honest, not lossy.
 *
 * exactOptionalPropertyTypes-safe: every optional field is attached via a conditional spread
 * (`...(x ? { x } : {})`), never `x: undefined`.
 */
export function buildAgentMetrics(
  usage: { inTokens: number; outTokens: number } | undefined,
  startedAt: number,
  toolCalls: number,
): AgentMetrics {
  const durationMs = Date.now() - startedAt
  const realUsage = usage !== undefined && !(usage.inTokens === 0 && usage.outTokens === 0)
  return {
    ...(realUsage ? { usage: { inTokens: usage.inTokens, outTokens: usage.outTokens } } : {}),
    durationMs,
    toolCalls,
  }
}
