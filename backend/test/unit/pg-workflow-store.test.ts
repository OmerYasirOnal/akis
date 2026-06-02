import { describe, it, expect } from 'vitest'
import { PgWorkflowStore } from '../../src/workflow/PgWorkflowStore.js'
import type { WorkflowStorePort } from '../../src/workflow/WorkflowStore.js'
import type { SqlClient } from '../../src/store/pg.js'

/** A fake SqlClient: records queries and returns scripted rows by a matcher
 *  (the shared pattern from pg-user-store.test.ts). The suite NEVER imports real `pg`. */
function fakeDb(handlers: { match: (sql: string) => boolean; rows: (params: unknown[]) => Array<Record<string, unknown>> }[]) {
  const calls: { text: string; params: unknown[] }[] = []
  const db: SqlClient = {
    async query(text, params = []) {
      calls.push({ text, params })
      const h = handlers.find(h => h.match(text))
      if (!h) return { rows: [] }
      return { rows: h.rows(params) }
    },
  }
  return { db, calls }
}

/** The raw `workflows` row shape `pg` returns (jsonb already parsed to JS). */
const row = (o: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: 'wf1', version: 1, name: 'wf', agents: [{ role: 'scribe' }],
  gate_policy: null, iterate_budget: null, rag: null, rerank: null, ...o,
})

describe('PgWorkflowStore', () => {
  it('conforms to WorkflowStorePort', () => {
    const { db } = fakeDb([])
    const store: WorkflowStorePort = new PgWorkflowStore(db)
    expect(store).toBeTruthy()
  })

  it('save assigns version 1 for a new id and appends an INSERT row', async () => {
    const { db, calls } = fakeDb([
      // MAX(version) lookup → no prior rows
      { match: s => s.includes('max(version)') || s.includes('MAX(version)'), rows: () => [{ max: null }] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, version: p[1] as number, name: p[2] as string })] },
    ])
    const store = new PgWorkflowStore(db, () => 'gen-id')
    const wf = await store.save({ name: 'wf', agents: [{ role: 'scribe' }] })
    expect(wf.id).toBe('gen-id')
    expect(wf.version).toBe(1)
    const insert = calls.find(c => c.text.startsWith('INSERT'))!
    expect(insert.text).toMatch(/INSERT INTO workflows/)
    // id, version, name, agents(jsonb), gate_policy, iterate_budget, rag, rerank
    expect(insert.params[0]).toBe('gen-id')
    expect(insert.params[1]).toBe(1)
    expect(insert.params[2]).toBe('wf')
  })

  it('save of an existing id bumps version to max+1', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.toLowerCase().includes('max(version)'), rows: () => [{ max: 4 }] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({ id: p[0] as string, version: p[1] as number })] },
    ])
    const store = new PgWorkflowStore(db)
    const wf = await store.save({ id: 'wf1', name: 'wf', agents: [{ role: 'scribe' }, { role: 'proto' }] })
    expect(wf.version).toBe(5)
    const insert = calls.find(c => c.text.startsWith('INSERT'))!
    expect(insert.params[1]).toBe(5)
  })

  it('save round-trips rag/rerank=false (NOT coerced to null) and gatePolicy as jsonb', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.toLowerCase().includes('max(version)'), rows: () => [{ max: null }] },
      { match: s => s.startsWith('INSERT'), rows: p => [row({
        id: p[0] as string, version: p[1] as number, name: p[2] as string,
        agents: p[3], gate_policy: p[4], iterate_budget: p[5], rag: p[6], rerank: p[7],
      })] },
    ])
    const store = new PgWorkflowStore(db, () => 'rr')
    const wf = await store.save({ name: 'rr', agents: [{ role: 'scribe' }], rag: true, rerank: false, iterateBudget: 2, gatePolicy: { requireCriticResolution: true } })
    const insert = calls.find(c => c.text.startsWith('INSERT'))!
    expect(insert.params[6]).toBe(true)   // rag
    expect(insert.params[7]).toBe(false)  // rerank — explicit false survives, not null
    expect(insert.params[5]).toBe(2)      // iterate_budget
    expect(insert.params[4]).toEqual({ requireCriticResolution: true }) // gate_policy jsonb
    // and the mapped result reflects the persisted row
    expect(wf.rag).toBe(true)
    expect(wf.rerank).toBe(false)
    expect(wf.iterateBudget).toBe(2)
    expect(wf.gatePolicy).toEqual({ requireCriticResolution: true })
  })

  it('get returns the latest version (ORDER BY version DESC) and maps the row', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [row({ version: 3, rerank: false })] },
    ])
    const store = new PgWorkflowStore(db)
    const wf = await store.get('wf1')
    expect(wf?.version).toBe(3)
    expect(wf?.rerank).toBe(false)
    expect(calls[0]!.text).toMatch(/ORDER BY version DESC/)
    expect(calls[0]!.params).toEqual(['wf1'])
  })

  it('get with a specific version filters on version=$2', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: p => (p[1] === 2 ? [row({ version: 2 })] : []) },
    ])
    const store = new PgWorkflowStore(db)
    const wf = await store.get('wf1', 2)
    expect(wf?.version).toBe(2)
    expect(calls[0]!.text).toMatch(/version = \$2/)
    expect(calls[0]!.params).toEqual(['wf1', 2])
  })

  it('get of an unknown id returns undefined', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [] }])
    expect(await new PgWorkflowStore(db).get('nope')).toBeUndefined()
  })

  it('list returns the latest row per id', async () => {
    const { db, calls } = fakeDb([
      { match: s => s.startsWith('SELECT'), rows: () => [row({ id: 'a', version: 2 }), row({ id: 'b', version: 1 })] },
    ])
    const list = await new PgWorkflowStore(db).list()
    expect(list).toHaveLength(2)
    expect(list.find(w => w.id === 'a')?.version).toBe(2)
    expect(calls[0]!.text).toMatch(/DISTINCT ON \(id\)/)
  })

  it('the row mapper omits optional fields when the column is null (exactOptionalPropertyTypes)', async () => {
    const { db } = fakeDb([{ match: s => s.startsWith('SELECT'), rows: () => [row({ gate_policy: null, iterate_budget: null, rag: null, rerank: null })] }])
    const wf = await new PgWorkflowStore(db).get('wf1')
    expect(wf).toBeDefined()
    expect('gatePolicy' in wf!).toBe(false)
    expect('iterateBudget' in wf!).toBe(false)
    expect('rag' in wf!).toBe(false)
    expect('rerank' in wf!).toBe(false)
  })
})
