import type { SqlClient } from '../store/pg.js'
import type { UsageRecord, UsageStorePort } from './UsageStore.js'

interface Row { owner_id: string; used_tokens: number | string; period_tokens: number | string; window_start: string | Date }

/** Map a node-pg row to a UsageRecord. `bigint` columns come back as STRINGS from node-pg,
 *  so coerce with Number(...) (mirrors PgUserStore's Number(r.token_version)). */
const toRecord = (r: Row): UsageRecord => ({
  ownerId: r.owner_id,
  usedTokens: Number(r.used_tokens),
  periodTokens: Number(r.period_tokens),
  windowStart: r.window_start instanceof Date ? r.window_start.toISOString() : String(r.window_start),
})

/**
 * Postgres-backed usage ledger — the SHARED source of truth across replicas (the in-memory
 * UsageStore is per-process). Pure SQL over an injected SqlClient — unit-testable with a fake
 * client and drop-in for a real `pg` Pool. Selected when DATABASE_URL is configured.
 *
 * `periodMs` is the budget window length. The window rolls forward at the DB level via a
 * `now() - periodMs` cutoff compared to the stored `window_start`: when the stored window is
 * older than the cutoff, the period resets. `get` presents a rolled READ VIEW without writing
 * (a read stays a SELECT); `add` rolls atomically in the UPSERT.
 */
export class PgUsageStore implements UsageStorePort {
  constructor(private db: SqlClient, private periodMs: number) {}

  /** The window cutoff: a stored window_start at-or-before this is expired. With periodMs <= 0
   *  the cutoff is the epoch, so a window is never older than it (never rolls — a single open
   *  window). `now` injectable for tests. */
  private cutoffIso(now: number): string {
    const ms = this.periodMs > 0 ? this.periodMs : Number.POSITIVE_INFINITY
    const cutoff = Number.isFinite(ms) ? now - ms : 0
    return new Date(cutoff).toISOString()
  }

  async add(ownerId: string, tokens: number, now = Date.now()): Promise<void> {
    const tok = Number.isFinite(tokens) && tokens > 0 ? tokens : 0
    const cutoff = this.cutoffIso(now)
    // INSERT a fresh row, or accumulate; reset period_tokens + window_start when the stored
    // window is expired (window_start <= cutoff). used_tokens always accumulates (lifetime).
    await this.db.query(
      `INSERT INTO user_usage (owner_id, used_tokens, window_start, period_tokens)
       VALUES ($1, $2, now(), $2)
       ON CONFLICT (owner_id) DO UPDATE SET
         used_tokens = user_usage.used_tokens + $2,
         period_tokens = CASE WHEN user_usage.window_start <= $3 THEN $2 ELSE user_usage.period_tokens + $2 END,
         window_start = CASE WHEN user_usage.window_start <= $3 THEN now() ELSE user_usage.window_start END`,
      [ownerId, tok, cutoff],
    )
  }

  async get(ownerId: string, now = Date.now()): Promise<UsageRecord> {
    const { rows } = await this.db.query('SELECT * FROM user_usage WHERE owner_id = $1', [ownerId])
    const r = rows[0] as unknown as Row | undefined
    if (!r) return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: new Date(now).toISOString() }
    const rec = toRecord(r)
    // Self-healing read view: if the stored window is expired, present a rolled period WITHOUT
    // writing (the read stays a SELECT — the write-side roll happens on the next add()).
    if (this.periodMs > 0 && new Date(rec.windowStart).getTime() <= now - this.periodMs) {
      return { ...rec, periodTokens: 0, windowStart: new Date(now).toISOString() }
    }
    return rec
  }

  async snapshotAll(): Promise<UsageRecord[]> {
    const { rows } = await this.db.query('SELECT * FROM user_usage', [])
    return rows.map(r => toRecord(r as unknown as Row))
  }
}

/** Wrap an already-built SqlClient (the shared pool) in a PgUsageStore. Used by the DI
 *  container so the usage ledger shares the SAME pool as users/sessions (the `user_usage`
 *  table is created by the shared runMigrations). Mirrors createPgUserStoreWithClient. */
export function createPgUsageStoreWithClient(db: SqlClient, periodMs: number): PgUsageStore {
  return new PgUsageStore(db, periodMs)
}
