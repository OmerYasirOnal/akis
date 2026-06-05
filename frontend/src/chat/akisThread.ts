/**
 * The "Ask AKIS" conversation thread — now the single chronological SPINE of the studio.
 * It is a flat ordered array of ThreadNodes, persisted as one localStorage key, where a node
 * is EITHER a chat message OR a run marker. The array index IS the chronology (no timestamps):
 * a run marker sits at the exact position where its SpecCard was approved, so a later build
 * naturally renders below the chat turns that preceded it.
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

const KEY = 'akis_chat_thread'
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

/** Load the persisted spine (oldest→newest): chat messages AND run markers, malformed nodes
 *  dropped. Safe against malformed/absent storage. */
export function loadThread(store: Pick<Storage, 'getItem'> | undefined = defaultStore()): ThreadNode[] {
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(isNode)
  } catch { return [] }
}

/** Persist the whole spine — chat messages and run markers serialize to the SAME key
 *  (best-effort; a full/blocked store is non-fatal). */
export function saveThread(nodes: readonly ThreadNode[], store: Pick<Storage, 'setItem'> | undefined = defaultStore()): void {
  try { store?.setItem(KEY, JSON.stringify(nodes)) } catch { /* storage full/blocked — non-fatal */ }
}

/** Clear the persisted thread (used by "new chat"). */
export function clearThread(store: Pick<Storage, 'removeItem'> | undefined = defaultStore()): void {
  try { store?.removeItem(KEY) } catch { /* non-fatal */ }
}

/**
 * True when a scroll container is at (or within a small slack of) the bottom. The chat uses
 * this as the auto-scroll guard: keep following new messages while the user is at the bottom,
 * but STOP auto-scrolling once they scroll up to read earlier history.
 */
export function isNearBottom(el: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack
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
