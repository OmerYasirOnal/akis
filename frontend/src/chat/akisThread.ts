/**
 * The "Ask AKIS" conversation thread — its message model, browser persistence, and the
 * filter that decides what history is safe to replay to the provider.
 *
 * Roles:
 *  - `user` / `assistant` — the real two-way conversation (the only roles sent to /api/chat).
 *  - `error` — a DISTINCT row for a provider/network/empty-reply failure. It is RENDERED
 *    (so the user sees what went wrong + can retry) but is NEVER sent back as history, so a
 *    failure can't poison AKIS's context on the next turn.
 *
 * Persistence mirrors recentBuilds.ts: localStorage-keyed, malformed-safe, non-fatal writes.
 * Lifting the thread into storage lets it SURVIVE a build starting (which unmounts the chat)
 * and a full page reload, so the user can always see the conversation that produced a build.
 */
export type AkisRole = 'user' | 'assistant' | 'error'
export interface AkisMsg { role: AkisRole; content: string }

const KEY = 'akis_chat_thread'
const ROLES: ReadonlySet<string> = new Set<AkisRole>(['user', 'assistant', 'error'])

function isMsg(v: unknown): v is AkisMsg {
  return !!v && typeof v === 'object'
    && typeof (v as AkisMsg).content === 'string'
    && ROLES.has((v as AkisMsg).role)
}

/** Resolve localStorage defensively — undefined in SSR and some privacy modes (where even
 *  *accessing* it throws), so callers degrade to an in-memory-only thread rather than crash. */
function defaultStore(): Storage | undefined {
  try { return typeof localStorage !== 'undefined' ? localStorage : undefined } catch { return undefined }
}

/** Load the persisted thread (oldest→newest). Safe against malformed/absent storage. */
export function loadThread(store: Pick<Storage, 'getItem'> | undefined = defaultStore()): AkisMsg[] {
  try {
    const raw = store?.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter(isMsg)
  } catch { return [] }
}

/** Persist the whole thread (best-effort; a full/blocked store is non-fatal). */
export function saveThread(msgs: AkisMsg[], store: Pick<Storage, 'setItem'> | undefined = defaultStore()): void {
  try { store?.setItem(KEY, JSON.stringify(msgs)) } catch { /* storage full/blocked — non-fatal */ }
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
 * The history to replay to POST /api/chat on the next send. Drops the opening greeting
 * (an assistant turn equal to `greeting`) AND every `error` row — so the provider only ever
 * sees the genuine user/assistant exchange, never a synthesized error string.
 */
export function historyForApi(msgs: AkisMsg[], greeting: string): { role: 'user' | 'assistant'; content: string }[] {
  return msgs
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => !(m.role === 'assistant' && m.content === greeting))
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}
