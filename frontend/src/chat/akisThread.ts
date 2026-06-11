/**
 * The "Ask AKIS" conversation thread — the chronological SPINE of the studio.
 * It is a flat ordered array of ThreadNodes, persisted to localStorage, where a node is EITHER a
 * chat message OR a run marker. The array index IS the chronology (no timestamps): a run marker
 * sits at the exact position where its SpecCard was approved, so a later build naturally renders
 * below the chat turns that preceded it.
 *
 * PER-CONVERSATION KEYING (the reorder/clobber fix). The spine used to live under ONE global key,
 * so opening a second chat (new build / a History reopen of a DIFFERENT session) overwrote it, and
 * returning to the first conversation lost its correctly-ordered local spine → the server REBUILD
 * branch fired and scrambled the order. Each conversation now persists under its OWN key:
 *  - `akis_chat_thread:draft` — the PRE-build phase (no build started yet).
 *  - `akis_chat_thread:<sessionId>` — once a build starts, the conversation is ANCHORED to its first
 *    run's session id (the draft is RENAMED to it). Multi-run threads keep their full, correctly
 *    ordered spine here. A History reopen reads this exact key, so switching A→B→A never clobbers.
 * The legacy single-key spine is migrated forward once (see `migrateLegacyKey`).
 *
 * Chat-message roles:
 *  - `user` / `assistant` — the real two-way conversation (the only roles sent to /api/chat).
 *  - `error` — a DISTINCT row for a provider/network/empty-reply failure. It is RENDERED
 *    (so the user sees what went wrong + can retry) but is NEVER sent back as history, so a
 *    failure can't poison AKIS's context on the next turn.
 *
 * Run marker (`role: 'run'`): carries ONLY the build's `sessionId` and `idea` — NO event data.
 *  On render each run marker mounts its own RunBlock, which re-subscribes to /events and replays
 *  /log to rebuild that run's transcript. This is what makes multi-run ordering free and reload-
 *  /reopen-safe: the spine persists the structure, the server replays the contents.
 *
 * Persistence mirrors recentBuilds.ts: localStorage-keyed, malformed-safe, non-fatal writes.
 * Lifting the thread into storage lets it SURVIVE a build starting (which unmounts the chat)
 * and a full page reload, so the user can always see the conversation that produced a build.
 */
export type AkisRole = 'user' | 'assistant' | 'error'
export interface AkisMsg { role: AkisRole; content: string }
/** A build anchor inside the spine. Holds only the session id + the idea, never event data. */
export interface RunNode { role: 'run'; sessionId: string; idea: string }
/** A node in the chronological spine: an existing chat message OR a run marker. */
export type ThreadNode = AkisMsg | RunNode

/** The legacy single global key (pre per-conversation keying). Migrated forward once, then unused. */
const LEGACY_KEY = 'akis_chat_thread'
/** Per-conversation key PREFIX. The suffix is the conversation anchor: `draft` or a session id. */
const KEY_PREFIX = 'akis_chat_thread:'
/** The pre-build conversation key — used until the first build anchors the conversation to a run id. */
export const DRAFT_KEY = `${KEY_PREFIX}draft`
/** The storage key for a conversation anchored to a build's session id. */
export function anchorKey(sessionId: string): string { return `${KEY_PREFIX}${sessionId}` }
const ROLES: ReadonlySet<string> = new Set<AkisRole>(['user', 'assistant', 'error'])

/** True for an ordinary chat message (user/assistant/error), false for a run marker. The run
 *  marker is discriminated by `role: 'run'`, so this also doubles as the spine's narrowing guard. */
export function isMsg(v: unknown): v is AkisMsg {
  return !!v && typeof v === 'object'
    && typeof (v as AkisMsg).content === 'string'
    && ROLES.has((v as AkisMsg).role)
}

/** True for a run marker — both string fields present and the `run` discriminator set. */
export function isRun(v: unknown): v is RunNode {
  return !!v && typeof v === 'object'
    && (v as RunNode).role === 'run'
    && typeof (v as RunNode).sessionId === 'string'
    && typeof (v as RunNode).idea === 'string'
}

/** A spine node is whatever survives the per-kind guards — anything else is malformed and dropped. */
function isNode(v: unknown): v is ThreadNode {
  return isMsg(v) || isRun(v)
}

/** Resolve localStorage defensively — undefined in SSR and some privacy modes (where even
 *  *accessing* it throws), so callers degrade to an in-memory-only thread rather than crash. */
function defaultStore(): Storage | undefined {
  try { return typeof localStorage !== 'undefined' ? localStorage : undefined } catch { return undefined }
}

/** Load the persisted spine for `key` (oldest→newest): chat messages AND run markers, malformed
 *  nodes dropped. Safe against malformed/absent storage. `key` defaults to DRAFT_KEY so a fresh,
 *  pre-build conversation persists under the draft key. */
export function loadThread(key: string = DRAFT_KEY, store: Pick<Storage, 'getItem'> | undefined = defaultStore()): ThreadNode[] {
  try {
    const raw = store?.getItem(key)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(isNode)
  } catch { return [] }
}

/** Persist the whole spine under `key` — chat messages and run markers serialize together
 *  (best-effort; a full/blocked store is non-fatal). */
export function saveThread(nodes: readonly ThreadNode[], key: string = DRAFT_KEY, store: Pick<Storage, 'setItem'> | undefined = defaultStore()): void {
  try { store?.setItem(key, JSON.stringify(nodes)) } catch { /* storage full/blocked — non-fatal */ }
}

/** Clear the persisted thread for `key` (used by "new chat" on the ACTIVE conversation). */
export function clearThread(key: string = DRAFT_KEY, store: Pick<Storage, 'removeItem'> | undefined = defaultStore()): void {
  try { store?.removeItem(key) } catch { /* non-fatal */ }
}

/** Wipe EVERY persisted conversation spine — the legacy key, the draft, and every per-build anchor.
 *  Used on LOGOUT (the cross-user-leak fix): per-conversation keying means there is no longer a
 *  single key to remove, so we enumerate and drop all `akis_chat_thread*` keys. Best-effort: a
 *  store that throws on enumeration (privacy modes) is a non-fatal no-op. */
export function clearAllThreads(store: Storage | undefined = defaultStore()): void {
  try {
    if (!store) return
    // Snapshot keys first — removing while iterating `store.key(i)` shifts indices.
    const keys: string[] = []
    for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k != null) keys.push(k) }
    for (const k of keys) if (k === LEGACY_KEY || k.startsWith(KEY_PREFIX)) store.removeItem(k)
  } catch { /* non-fatal */ }
}

/** Move the spine from `from` to `to` (the draft→anchor promotion when the first build starts):
 *  copy the source under the destination key and drop the source. No-op when from===to or the
 *  source is empty. Best-effort — a read/write failure leaves the source in place (non-fatal). */
export function renameThread(from: string, to: string, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = defaultStore()): void {
  if (from === to) return
  try {
    const raw = store?.getItem(from)
    if (raw == null) return
    store?.setItem(to, raw)
    store?.removeItem(from)
  } catch { /* non-fatal */ }
}

/**
 * One-time forward migration of the LEGACY single-key spine to the per-conversation scheme.
 * Old installs persisted everything under `akis_chat_thread`; this moves it to the right per-
 * conversation key so no conversation is lost when the keying changes:
 *  - if the legacy spine already anchors a build (has a run marker), migrate it to THAT run's
 *    anchor key — so a legacy ?s=<id> reopen finds its own correctly-ordered spine;
 *  - otherwise it is a pre-build draft → migrate to DRAFT_KEY.
 * Idempotent + non-destructive: skips when the legacy key is absent OR the destination already
 * holds a spine (a newer same-conversation write must win). Safe against malformed/blocked storage.
 */
export function migrateLegacyKey(store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = defaultStore()): void {
  try {
    const raw = store?.getItem(LEGACY_KEY)
    if (raw == null) return
    const arr = JSON.parse(raw) as unknown
    const nodes = Array.isArray(arr) ? arr.filter(isNode) : []
    const firstRun = nodes.find(isRun)
    const dest = firstRun ? anchorKey(firstRun.sessionId) : DRAFT_KEY
    // Don't clobber a destination that already has content (a newer write for the same conversation).
    if (store?.getItem(dest) == null) store?.setItem(dest, JSON.stringify(nodes))
    store?.removeItem(LEGACY_KEY)
  } catch { /* non-fatal — a failed migration just leaves the legacy key untouched */ }
}

/**
 * True when a scroll container is at (or within a small slack of) the bottom. The chat uses
 * this as the auto-scroll guard: keep following new messages while the user is at the bottom,
 * but STOP auto-scrolling once they scroll up to read earlier history.
 */
export function isNearBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack
}

/** Reconcile the persisted local spine with the server's session.chat on a reopen.
 *  If the local spine already anchors this run (has its run marker), it is the richest copy
 *  (it includes the pre-build, sessionId-less turns the server can never hold) → keep it. Under
 *  per-conversation keying this is now the DOMINANT path: switching chats no longer clobbers a
 *  conversation's spine, so a same-device reopen reliably finds its own correctly-ordered local copy.
 *  Otherwise (cleared storage / another device / a legacy install) rebuild from the server turns,
 *  placing the run marker DETERMINISTICALLY: pre-build turns (`phase:'pre'`) BEFORE the marker, the
 *  post-build follow-up turns AFTER it. This is the H2 fix — the old rebuild put the marker before
 *  ALL restored turns, so a reopen rendered the run block above the conversation that produced it.
 *  (Turns with no phase are treated as pre-build for legacy rows that predate the phase tag, which
 *  preserves their original under-the-marker render.) Adjacent identical (role,content) pairs are
 *  de-duplicated. Pure + storage-free.
 *  NOTE: in the keep-local branch, newer SERVER turns (e.g. follow-up turns made on ANOTHER device
 *  about the same build) are intentionally NOT merged in — staleness is accepted over the re-dedupe
 *  complexity that merging two diverged spines would need (no per-turn ids to align on). Do not
 *  "also merge server turns here": it reintroduces the duplicate-turn class this branch avoids. */
export function mergeSpine(args: {
  local: readonly ThreadNode[]
  serverTurns: readonly { role: 'user' | 'assistant'; content: string; phase?: 'pre' }[]
  id: string
  greeting: string
  idea: string
}): ThreadNode[] {
  const { local, serverTurns, id, greeting, idea } = args
  const hasMarker = local.some(n => isRun(n) && n.sessionId === id)
  let base: ThreadNode[]
  if (hasMarker) {
    base = [...local]
  } else {
    // SPLIT the restored server turns around the run marker by their phase tag: ONLY turns the
    // server explicitly tagged `phase:'pre'` (the spec-shaping conversation, seeded at creation)
    // render BEFORE the marker; everything else renders AFTER it. This is the H2 fix AND it preserves
    // the LEGACY render: rows persisted before the phase tag have no `phase`, so they land after the
    // marker exactly as the old `[greeting, run, ...turns]` rebuild did (post-build follow-ups the
    // chat route appends are likewise untagged → after the marker — chronologic).
    const nonEmpty = serverTurns.filter(t => t.content.trim().length > 0)
    const pre = nonEmpty.filter(t => t.phase === 'pre').map(t => ({ role: t.role, content: t.content }))
    const post = nonEmpty.filter(t => t.phase !== 'pre').map(t => ({ role: t.role, content: t.content }))
    base = [{ role: 'assistant', content: greeting }, ...pre,
            { role: 'run', sessionId: id, idea: idea.trim() }, ...post]
  }
  return base.filter((n, i) => {
    const p = base[i - 1]
    if (!p || isRun(n) || isRun(p)) return true
    return !(n.role === p.role && n.content === p.content)
  })
}

/**
 * The history to replay to POST /api/chat on the next send. SKIPS run markers (so the build-
 * aware context never bloats with run data), drops the opening greeting (an assistant turn
 * equal to `greeting`) AND every `error` row — so the provider only ever sees the genuine
 * user/assistant exchange, never a run marker or a synthesized error string.
 */
export function historyForApi(nodes: readonly ThreadNode[], greeting: string): { role: 'user' | 'assistant'; content: string }[] {
  return nodes
    .filter((m): m is AkisMsg => isMsg(m) && (m.role === 'user' || m.role === 'assistant'))
    .filter(m => !(m.role === 'assistant' && m.content === greeting))
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}
