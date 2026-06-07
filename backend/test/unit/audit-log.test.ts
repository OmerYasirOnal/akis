import { describe, it, expect } from 'vitest'
import { PgAuditStore, attachAuditLog, type AuditStore } from '../../src/audit/AuditLog.js'
import { EventBus } from '../../src/events/bus.js'
import type { SqlClient } from '../../src/store/pg.js'
import type { AkisEvent } from '@akis/shared'

/**
 * Move 3a — the durable audit ledger. A bus.tap persists every event to audit_events (idempotent
 * on (session_id, seq)), best-effort so a slow/failed DB never stalls or crashes the producer.
 */
const ev = (sessionId: string, kind = 'text'): AkisEvent => ({ kind, agent: 'orchestrator', laneId: 'main', sessionId, ts: 1, text: 'x' } as AkisEvent)

describe('PgAuditStore', () => {
  function fakeSql() {
    const calls: { text: string; params: unknown[] }[] = []
    const sql: SqlClient = { async query(text: string, params: unknown[] = []) { calls.push({ text, params }); return { rows: [] } } }
    return { sql, calls }
  }
  it('append: idempotent INSERT (ON CONFLICT DO NOTHING) with a JSON-stringified jsonb payload', async () => {
    const { sql, calls } = fakeSql()
    await new PgAuditStore(sql).append('s1', 7, 'done', { kind: 'done', verified: true })
    expect(calls[0]!.text).toMatch(/INSERT INTO audit_events/)
    expect(calls[0]!.text).toMatch(/ON CONFLICT \(session_id, seq\) DO NOTHING/)
    expect(calls[0]!.params.slice(0, 3)).toEqual(['s1', 7, 'done'])
    expect(typeof calls[0]!.params[3]).toBe('string') // jsonb payload stringified (the array-vs-json lesson)
    expect(JSON.parse(calls[0]!.params[3] as string)).toEqual({ kind: 'done', verified: true })
  })
  it('listBySession: orders by seq ASC, is BOUNDED (LIMIT), owner-scopes by session, maps rows in order', async () => {
    let captured: { text: string; params: unknown[] | undefined } | undefined
    const sql: SqlClient = {
      async query(text: string, params?: unknown[]) {
        captured = { text, params }
        return { rows: [
          { seq: 1, ts: 't1', kind: 'agent_start', payload: { a: 1 } },
          { seq: 2, ts: 't2', kind: 'done', payload: { b: 2 } },
        ] }
      },
    }
    const out = await new PgAuditStore(sql).listBySession('s1')
    // seq-order + bound + owner-scope are SQL-contract invariants (not incidental) — pin them.
    expect(captured?.text).toMatch(/ORDER BY seq ASC/i)
    expect(captured?.text).toMatch(/LIMIT \d+/i)
    expect(captured?.text).toMatch(/WHERE session_id = \$1/i)
    expect(captured?.params).toEqual(['s1'])
    expect(out).toEqual([
      { seq: 1, ts: 't1', kind: 'agent_start', payload: { a: 1 } },
      { seq: 2, ts: 't2', kind: 'done', payload: { b: 2 } },
    ])
    expect(out.map(e => e.seq)).toEqual([1, 2]) // mapped in seq order
  })
})

describe('attachAuditLog (bus.tap writer)', () => {
  it('persists every emitted event with (sessionId, seq, kind, event)', async () => {
    const seen: { id: string; seq: number; kind: string }[] = []
    const store: AuditStore = {
      async append(id, seq, kind) { seen.push({ id, seq, kind }) },
      async listBySession() { return [] },
    }
    const bus = new EventBus()
    attachAuditLog(bus, store)
    bus.emit(ev('s1', 'agent_start'))
    bus.emit(ev('s1', 'done'))
    await Promise.resolve() // let the fire-and-forget appends settle
    expect(seen).toEqual([{ id: 's1', seq: 1, kind: 'agent_start' }, { id: 's1', seq: 2, kind: 'done' }])
  })
  it('a throwing store NEVER crashes the producer (best-effort)', () => {
    const store: AuditStore = { async append() { throw new Error('db down') }, async listBySession() { return [] } }
    const bus = new EventBus()
    attachAuditLog(bus, store)
    expect(() => bus.emit(ev('s1'))).not.toThrow() // the emit is unaffected by a failing audit write
  })
})
