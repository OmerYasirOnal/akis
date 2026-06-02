export interface RecentBuild { id: string; idea: string; ts: number }

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
