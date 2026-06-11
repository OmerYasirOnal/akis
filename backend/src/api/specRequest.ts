/**
 * The chat → Scribe HANDOFF contract (pure, server-side).
 *
 * Option A (owner decision 2026-06-11): the build-ready spec is drafted by the REAL
 * ScribeAgent, not the AKIS chat persona. So when the conversation reaches "ready to
 * spec", the persona STOPS authoring a full spec and instead emits a COMPACT
 * `akis-spec-request` fence carrying a one-line brief / requirements summary. The chat
 * route detects this AFTER the persona stream completes, hands the brief (+ the bounded
 * conversation) to the real Scribe, and emits Scribe's spec as the standard `akis-spec`
 * block the FE already renders under the Scribe identity.
 *
 * The request fence is held to the SAME strictness as the build `akis-spec` fence
 * (frontend/src/chat/buildSpec.ts) — a stable, versionable seam, NOT loose prose matching:
 *  - backtick-count-aware: the closing fence run must match the OPENING run, so an inner
 *    ```code block inside a ````akis-spec-request block never truncates it (CommonMark).
 *  - tolerant of <=3 leading spaces on the fence lines (CommonMark indented fences).
 *  - the info string must be a COMPLETE token (`akis-spec-request`, optionally followed by
 *    whitespace+extra tokens) — `akis-spec-requestX` is NOT the tag.
 *  - it must NOT collide with the build `akis-spec` fence — the negative lookahead
 *    `akis-spec(?!-request)` is unnecessary because we require the literal `-request`
 *    suffix and a token boundary, but the two regexes are distinct by construction.
 *
 * Tolerant by design: a missing / unclosed / empty block returns null so a truncated stream
 * degrades to a plain rendered reply (no half-formed handoff to Scribe).
 *
 * SACRED: this is a presentation/routing seam ONLY. The request fence carries NO authority —
 * it can never approve/verify/push/mint. The human SpecCard click remains the sole approve
 * path; a prompt-injected request fence can at most cause Scribe to draft ANOTHER spec card
 * the human still has to approve.
 */
export interface SpecRequest {
  /** The one-line brief / requirements summary inside the fence (trimmed). */
  brief: string
  /** Text that appeared before the request fence (trimmed; '' if none). */
  intro: string
}

// Opening fence: (<=3 spaces) a run of >=3 backticks + `akis-spec-request` as a COMPLETE info
// token (a whitespace boundary or end-of-line after it), the brief body, then a CLOSING fence
// whose backtick run matches the opening (\2) — so an inner ```code block does not close it.
const REQUEST_BLOCK = /(^|\n)[ ]{0,3}(`{3,})akis-spec-request(?:[ \t][^\n]*)?\n([\s\S]*?)\r?\n[ ]{0,3}\2`*[ \t]*(?:\n|$)/

/** The brief + the intro before it, or null when there is no CLOSED, non-empty request block. */
export function extractSpecRequest(message: string): SpecRequest | null {
  if (typeof message !== 'string') return null
  const m = REQUEST_BLOCK.exec(message)
  if (!m) return null
  const brief = (m[3] ?? '').trim()
  if (!brief) return null
  const intro = message.slice(0, m.index).trim()
  return { brief, intro }
}

/** True when a closed, non-empty request fence is present. */
export function hasSpecRequest(message: string): boolean {
  return extractSpecRequest(message) !== null
}

/** Remove the request fence from a reply, returning ONLY the surrounding prose (trimmed). The
 *  fence is an INTERNAL handoff marker — it must never render to the user. A reply with no fence
 *  passes through unchanged (trimmed). */
export function stripSpecRequest(message: string): string {
  if (typeof message !== 'string') return ''
  const m = REQUEST_BLOCK.exec(message)
  if (!m) return message.trim()
  return (message.slice(0, m.index) + message.slice(m.index + m[0].length)).trim()
}
