export interface RecentBuild {
  id: string
  idea: string
  ts: number
  /** The backend SessionStatus, when known (server-backed history rows carry it) — drives the
   *  localized status pill in the History menu (P1-7). Absent for a locally-recorded build that
   *  predates the status, or a fresh recordRecentBuild (no status yet) — the pill is then omitted. */
  status?: string
  /** Whether the build is verified (server-backed rows) — drives the ✓ mark in the menu (P1-7). */
  verified?: boolean
}

/** A clean, single-line title from a raw idea/spec. A chat-authored build's `idea` is the
 *  whole spec markdown (e.g. "# Minimal Todo App\n## Scope …"), so a history row would show
 *  raw "#"/"##" noise — take the first non-empty line and strip leading heading hashes +
 *  surrounding emphasis so the row reads as a real title. */
export function ideaTitle(idea: string): string {
  const first = (idea ?? '').split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return first.replace(/^#{1,6}\s*/, '').replace(/^\*+|\*+$/g, '').trim()
}

const KEY = 'akis_recent_builds'
const MAX = 8

/** Load recent builds (newest first). Safe against malformed/absent storage. */
export function loadRecentBuilds(store: Pick<Storage, 'getItem'> = localStorage): RecentBuild[] {
  try {
    const raw = store.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((b): b is RecentBuild =>
      !!b && typeof b === 'object' && typeof (b as RecentBuild).id === 'string' && typeof (b as RecentBuild).idea === 'string' && typeof (b as RecentBuild).ts === 'number')
  } catch { return [] }
}

/** Record a build at the front (dedup by id, cap to MAX). Returns the new list. */
export function recordRecentBuild(entry: RecentBuild, store: Pick<Storage, 'getItem' | 'setItem'> = localStorage): RecentBuild[] {
  const next = [entry, ...loadRecentBuilds(store).filter(b => b.id !== entry.id)].slice(0, MAX)
  try { store.setItem(KEY, JSON.stringify(next)) } catch { /* storage full/blocked — non-fatal */ }
  return next
}
