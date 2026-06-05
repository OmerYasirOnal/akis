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

// Quick-reply SUGGESTIONS: AKIS may end a reply with a fenced `akis-suggest` block, one short
// suggestion per line (optionally bulleted), which the UI turns into tappable chips. Same
// backtick-count-aware, indent-tolerant fencing as akis-spec so the seam is consistent.
const SUGGEST_BLOCK = /(^|\n)[ ]{0,3}(`{3,})akis-suggest(?:[ \t][^\n]*)?\r?\n([\s\S]*?)\r?\n[ ]{0,3}\2`*[ \t]*(?:\r?\n|$)/

/**
 * Pull tappable quick-reply suggestions out of an `akis-suggest` block and return them along
 * with the message text STRIPPED of that block (so the raw marker never renders). Tolerant: no
 * block → empty list + the original text. Caps at 4 short suggestions; blank lines dropped.
 */
export function extractSuggestions(message: string): { suggestions: string[]; text: string } {
  if (typeof message !== 'string') return { suggestions: [], text: typeof message === 'string' ? message : '' }
  const m = SUGGEST_BLOCK.exec(message)
  if (!m) return { suggestions: [], text: message }
  const suggestions = (m[3] ?? '')
    .split('\n')
    .map(l => l.replace(/^[ \t]*[-*•][ \t]+/, '').trim())
    .filter(Boolean)
    .slice(0, 4)
  const text = (message.slice(0, m.index) + message.slice(m.index + m[0].length)).trim()
  return { suggestions, text }
}

/**
 * Split a chat-approved spec MARKDOWN string into the {title, body} seed the backend
 * persists as the AUTHORITATIVE SpecArtifact (P0-1) — so the chat's spec is NOT silently
 * re-authored by Scribe. The title is the first markdown heading (leading #'s stripped),
 * falling back to the first non-empty line, then a generic label; the body is the FULL spec
 * text (heading included) so nothing the human approved is dropped. Pure + UI-free.
 */
export function specSeedFromMarkdown(spec: string): { title: string; body: string } {
  const text = (typeof spec === 'string' ? spec : '').trim()
  const firstLine = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const title = firstLine.replace(/^#{1,6}\s*/, '').replace(/^\*+|\*+$/g, '').trim() || 'Untitled spec'
  // The body is the whole approved spec markdown — the title heading is part of the spec the
  // human read and approved, so it stays in the body the agents build from.
  return { title: title.slice(0, 200), body: text }
}

// An OPENING akis-spec fence with NO required closing fence after it — same opener shape as
// SPEC_BLOCK but without the matching close. Anchored to a line so an inner ```code fence
// (a different info string) is never mistaken for the opener.
const SPEC_OPEN = /(^|\n)[ ]{0,3}`{3,}akis-spec(?:[ \t][^\n]*)?(\n|$)/

/**
 * True when AKIS clearly *started* emitting a build spec (an `akis-spec` fence opened) but
 * `extractBuildSpec` can't recover it — i.e. the reply was cut off before the closing fence
 * (e.g. maxTokens). The UI uses this to show an honest "spec was truncated — ask AKIS to
 * resend it" notice instead of rendering a half spec as plain prose with no Build card.
 */
export function hasTruncatedSpec(message: string): boolean {
  if (typeof message !== 'string') return false
  return SPEC_OPEN.test(message) && extractBuildSpec(message) === null
}
