import type { AkisEvent } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { SqlClient } from '../store/pg.js'

/**
 * DURABLE AUDIT LEDGER (strategy Move 3a). A {@link bus.tap} writer that persists every emitted
 * event to the append-only `audit_events` table, so a build's full chronological trail survives a
 * restart in a QUERYABLE form — the durable backing for the provenance story (the in-memory replay
 * buffer is LRU-capped + restart-volatile; the dev bus-snapshot is a single JSON file).
 *
 * Writes are BEST-EFFORT + fire-and-forget: the tap callback is synchronous and must never block or
 * throw back into the producer, so a failed insert is swallowed. The ledger is OBSERVABILITY ONLY —
 * it holds no gate capability, mints nothing, and is read owner-scoped via the session.
 */
export interface AuditEntry { seq: number; ts: string; kind: string; payload: unknown }

export interface AuditStore {
  /** Append one event (idempotent on (sessionId, seq) — a replayed seq is a no-op). */
  append(sessionId: string, seq: number, kind: string, payload: unknown): Promise<void>
  /** The session's events in seq order (bounded), for the owner-scoped audit view. */
  listBySession(sessionId: string): Promise<AuditEntry[]>
}

/** Postgres-backed audit store. payload is JSON.stringify'd for the jsonb column (node-pg renders a
 *  JS object as json but a JS ARRAY as a Postgres array literal — see PgSessionStore.toJson). */
export class PgAuditStore implements AuditStore {
  constructor(private sql: SqlClient) {}
  async append(sessionId: string, seq: number, kind: string, payload: unknown): Promise<void> {
    await this.sql.query(
      `INSERT INTO audit_events (session_id, seq, kind, payload) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, seq) DO NOTHING`,
      [sessionId, seq, kind, payload == null ? null : JSON.stringify(payload)],
    )
  }
  async listBySession(sessionId: string): Promise<AuditEntry[]> {
    const { rows } = await this.sql.query(
      `SELECT seq, ts, kind, payload FROM audit_events WHERE session_id = $1 ORDER BY seq ASC LIMIT 2000`,
      [sessionId],
    )
    return (rows as { seq: number; ts: unknown; kind: string; payload: unknown }[]).map(r => ({
      seq: Number(r.seq), ts: String(r.ts), kind: r.kind, payload: r.payload,
    }))
  }
}

/**
 * Tap the bus and persist every event to the {@link AuditStore}. Returns the detach fn. The write
 * is fire-and-forget (a rejected insert is swallowed) so a slow/failed DB can NEVER stall or crash
 * the producer that emitted the event.
 */
export function attachAuditLog(bus: EventBus, store: AuditStore): () => void {
  return bus.tap((e: AkisEvent, seq: number) => {
    void store.append(e.sessionId, seq, e.kind, e).catch(() => { /* best-effort audit write */ })
  })
}
