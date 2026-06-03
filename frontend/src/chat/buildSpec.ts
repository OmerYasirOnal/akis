/**
 * The Chat-to-Build contract (pure, UI-free).
 *
 * When AKIS is genuinely offering a build, its persona emits the spec inside a fenced
 * block whose info string is `akis-spec`:
 *
 *     Here's a spec you can build 👇
 *     ```akis-spec
 *     # TODO App
 *     … the spec in markdown …
 *     ```
 *
 * `extractBuildSpec` keys ONLY on that fence tag — never on prose — so the contract is a
 * stable, versionable seam between the backend persona and the frontend. The info string
 * may carry extra tokens (e.g. `akis-spec v=2`) without breaking detection.
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

// Opening fence: line-start ```akis-spec (optionally followed by more info-string tokens),
// then the body, up to the next closing ``` fence on its own line. First block wins.
const SPEC_BLOCK = /(^|\n)```akis-spec\b[^\n]*\n([\s\S]*?)\n```/

/** Return the spec + the intro before it, or null if there is no closed akis-spec block. */
export function extractBuildSpec(message: string): BuildSpec | null {
  if (typeof message !== 'string') return null
  const m = SPEC_BLOCK.exec(message)
  if (!m) return null
  const spec = (m[2] ?? '').trim()
  if (!spec) return null
  const intro = message.slice(0, m.index).trim()
  return { intro, spec }
}
