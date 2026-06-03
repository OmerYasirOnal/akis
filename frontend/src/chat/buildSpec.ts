/**
 * The Chat-to-Build contract (pure, UI-free).
 *
 * When AKIS is genuinely offering a build, its persona emits the spec inside a fenced
 * block whose info string is `akis-spec`. The fence uses FOUR backticks so the spec body
 * may itself contain ordinary triple-backtick code examples without closing early:
 *
 *     Here's a spec you can build 👇
 *     ````akis-spec
 *     # TODO App
 *     … the spec in markdown, may include ```js code blocks … …
 *     ````
 *
 * `extractBuildSpec` keys ONLY on that fence tag — never on prose — so the contract is a
 * stable, versionable seam between the backend persona and the frontend. Detection is:
 *  - backtick-count-aware: the closing fence run must match the OPENING run, so an inner
 *    3-backtick code block inside a 4-backtick akis-spec block never truncates it
 *    (CommonMark fencing). Persona emits 4; any run of N≥3 is accepted symmetrically.
 *  - tolerant of ≤3 leading spaces on the fence lines (CommonMark indented fences).
 *  - the info string may carry extra tokens (e.g. `akis-spec v=2`), but `akis-spec-v2`
 *    (no separator) is NOT treated as the tag.
 *
 * Tolerant by design: a missing or unclosed block returns `null` so an older AKIS or a
 * partial stream degrades to a plain rendered message rather than breaking the chat.
 */
export interface BuildSpec {
  /** Text that appeared before the akis-spec block (trimmed; '' if none). */
  intro: string
  /** The spec markdown inside the block (trimmed). */
  spec: string
}

// Opening fence: (≤3 spaces) a run of ≥3 backticks + `akis-spec` as a complete info token,
// then the body, up to a CLOSING fence whose backtick run matches the opening (\2) — so an
// inner ```code block inside a ````akis-spec block does not close it. First block wins.
const SPEC_BLOCK = /(^|\n)[ ]{0,3}(`{3,})akis-spec(?:[ \t][^\n]*)?\n([\s\S]*?)\r?\n[ ]{0,3}\2`*[ \t]*(?:\n|$)/

/** Return the spec + the intro before it, or null if there is no closed akis-spec block. */
export function extractBuildSpec(message: string): BuildSpec | null {
  if (typeof message !== 'string') return null
  const m = SPEC_BLOCK.exec(message)
  if (!m) return null
  const spec = (m[3] ?? '').trim()
  if (!spec) return null
  const intro = message.slice(0, m.index).trim()
  return { intro, spec }
}
