import { describe, it, expect } from 'vitest'
import { loadRecentBuilds, recordRecentBuild } from './recentBuilds.js'

function memStore(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

describe('recentBuilds', () => {
  it('records newest-first, dedups by id, caps at 8', () => {
    const s = memStore()
    for (let i = 0; i < 10; i++) recordRecentBuild({ id: `s${i}`, idea: `idea ${i}`, ts: i }, s)
    const list = loadRecentBuilds(s)
    expect(list).toHaveLength(8)
    expect(list[0]!.id).toBe('s9')        // newest first
    expect(list.find(b => b.id === 's0')).toBeUndefined() // oldest evicted
  })

  it('re-recording an id moves it to the front without duplicating', () => {
    const s = memStore()
    recordRecentBuild({ id: 'a', idea: 'A', ts: 1 }, s)
    recordRecentBuild({ id: 'b', idea: 'B', ts: 2 }, s)
    recordRecentBuild({ id: 'a', idea: 'A2', ts: 3 }, s)
    const list = loadRecentBuilds(s)
    expect(list.map(b => b.id)).toEqual(['a', 'b'])
    expect(list[0]!.idea).toBe('A2')
  })

  it('returns [] for absent/malformed storage', () => {
    const s = memStore()
    expect(loadRecentBuilds(s)).toEqual([])
    s.setItem('akis_recent_builds', 'not json')
    expect(loadRecentBuilds(s)).toEqual([])
  })
})
