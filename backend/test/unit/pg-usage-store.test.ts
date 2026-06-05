import { describe, it, expect } from 'vitest'
import { PgUsageStore, createPgUsageStoreWithClient } from '../../src/usage/PgUsageStore.js'
import type { SqlClient } from '../../src/store/pg.js'

/** A fake SqlClient: records queries and returns scripted rows by a matcher. */
function fakeDb(handlers: { match: (sql: string) => boolean; rows: (params: unknown[]) => Array<Record<string, unknown>> }[]) {
  const calls: { text: string; params: unknown[] }[] = []
  const db: SqlClient = {
    async query(text, params = []) {
      calls.push({ text, params })
      const h = handlers.find(h => h.match(text))
      return { rows: h ? h.rows(params) : [] }
    },
  }
  return { db, calls }
}

const row = (o: Partial<Record<string, unknown>>) => ({
  owner_id: 'ada', used_tokens: '0', period_tokens: '0', window_start: '2026-06-05T00:00:00.000Z', ...o,
})

describe('PgUsageStore', () => {
  it('add issues the UPSERT with owner_id + token delta + window cutoff params', async () => {
    const { db, calls } = fakeDb([{ match: s => s.startsWith('INSERT'), rows: () => [] }])
    const store = new PgUsageStore(db, 1000)
    await store.add('ada', 42, 5_000_000)
    expect(calls[0]!.text).toMatch(/INSERT INTO user_usage/)
    expect(calls[0]!.text).toMatch(/ON CONFLICT \(owner_id\) DO UPDATE/)
    // params: [owner_id, tokens, cutoff = now - periodMs]
    expect(calls[0]!.params[0]).toBe('ada')
    expect(calls[0]!.params[1]).toBe(42)
    expect(new Date(calls[0]!.params[2] as string).getTime()).toBe(5_000_000 - 1000)
  })

  it('get SELECTs and maps the row; rolls the window in the read view when window_start <= cutoff', async () => {
    // window_start is OLD (before the now-periodMs cutoff) → the read view rolls: periodTokens 0.
    // now=5_000_000ms, periodMs=1000 → cutoff=4_999_000ms; window_start at 1_000_000ms is older.
    const { db } = fakeDb([{
      match: s => s.startsWith('SELECT'),
      rows: () => [row({ owner_id: 'ada', used_tokens: '500', period_tokens: '300', window_start: new Date(1_000_000).toISOString() })],
    }])
    const store = new PgUsageStore(db, 1000)
    const r = await store.get('ada', 5_000_000)
    expect(r.usedTokens).toBe(500)   // lifetime persists
    expect(r.periodTokens).toBe(0)   // rolled in the read view
  })

  it('get within the window returns the row as-is (no roll)', async () => {
    const fresh = new Date(5_000_000).toISOString()
    const { db } = fakeDb([{
      match: s => s.startsWith('SELECT'),
      rows: () => [row({ owner_id: 'ada', used_tokens: '500', period_tokens: '300', window_start: fresh })],
    }])
    const store = new PgUsageStore(db, 1000)
    const r = await store.get('ada', 5_000_200) // within 1000ms of window_start
    expect(r.periodTokens).toBe(300)
  })

  it('get returns a zero record when no row', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [] }])
    const store = new PgUsageStore(db, 1000)
    const r = await store.get('nobody', 5_000_000)
    expect(r.usedTokens).toBe(0)
    expect(r.periodTokens).toBe(0)
    expect(r.ownerId).toBe('nobody')
  })

  it('row mapper coerces node-pg bigint-as-string used_tokens/period_tokens via Number()', async () => {
    const { db } = fakeDb([{
      match: s => s.startsWith('SELECT'),
      rows: () => [row({ used_tokens: '123456789012', period_tokens: '42', window_start: new Date(5_000_000).toISOString() })],
    }])
    const store = new PgUsageStore(db, 1000)
    const r = await store.get('ada', 5_000_100)
    expect(r.usedTokens).toBe(123456789012)
    expect(typeof r.usedTokens).toBe('number')
    expect(r.periodTokens).toBe(42)
  })

  it('createPgUsageStoreWithClient builds a working store over the injected client', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [] }])
    const store = createPgUsageStoreWithClient(db, 1000)
    expect((await store.get('x', 1)).usedTokens).toBe(0)
  })
})
