/**
 * Per-user token usage ledger — the accounting signal behind the per-user token quota
 * (multi-tenant safety: one user must not be able to drain the shared provider budget).
 *
 * Token COUNTS are NOT secrets (the codebase already treats them so — see AgentMetrics in
 * shared/src/events.ts and backend/src/agent/metrics.ts), so a usage record is plain numbers.
 *
 * Honesty rules (mirror buildAgentMetrics): a recorded total is an AUTHORITATIVE-but-LOWER-BOUND
 * on true spend — it is accumulated only from REAL provider-reported usage and never fabricated;
 * absent/zero usage adds 0. Negative/NaN/Infinity are clamped to 0 (never trust a number into
 * accounting). This is a budget PRE-CHECK signal, so failing OPEN on an undercount is correct.
 *
 * WINDOWING: `periodTokens` is the spend within the CURRENT budget window; `usedTokens` is the
 * lifetime accumulator (never reset). The window rolls forward LAZILY on read/write when
 * `now - windowStart >= periodMs` — so reads are self-healing and NO cron is needed.
 * `periodMs` of 0/undefined ⇒ a single open window that never rolls.
 */
export interface UsageRecord {
  ownerId: string
  /** Lifetime accumulator (never reset). */
  usedTokens: number
  /** ISO timestamp when the CURRENT window began. */
  windowStart: string
  /** Tokens within the current window (reset when the window rolls). */
  periodTokens: number
}

/** The persistence seam — implemented by the in-memory {@link UsageStore} and {@link PgUsageStore}. */
export interface UsageStorePort {
  /** Accumulate `tokens` for `ownerId` (clamped to >= 0). `now` injectable for tests. */
  add(ownerId: string, tokens: number, now?: number): Promise<void>
  /** Read the owner's record, ROLLING the window forward in the returned view when it has
   *  expired (so callers always see the current period). Returns a zero record for an
   *  unknown owner. */
  get(ownerId: string, now?: number): Promise<UsageRecord>
  /** Every record (operator/observability). */
  snapshotAll(): Promise<UsageRecord[]>
}

/** Clamp any number into a safe non-negative integer-ish token count. Never trust a number
 *  flowing into accounting: NaN/Infinity/negatives become 0. */
function clampTokens(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0
}

export interface UsageStoreOpts {
  /** Window length in ms. 0/undefined ⇒ a single open window that never rolls. */
  periodMs?: number
  /** Injectable wall-clock (ms) for deterministic tests. */
  clock?: () => number
}

/**
 * In-memory usage ledger (the default). PER-PROCESS: in a multi-replica deployment WITHOUT
 * Postgres it can under-count per user (each replica has its own Map) — the {@link PgUsageStore}
 * (UPSERT) is the shared source of truth across replicas. This mirrors the existing per-process
 * caveat in auth/rateLimit.ts. Injectable `clock` for deterministic window-roll tests.
 */
export class UsageStore implements UsageStorePort {
  private records = new Map<string, UsageRecord>()
  private readonly periodMs: number
  private readonly clock: () => number
  constructor(opts: UsageStoreOpts = {}) {
    this.periodMs = opts.periodMs && opts.periodMs > 0 ? opts.periodMs : 0
    this.clock = opts.clock ?? Date.now
  }

  /** Whether the record's window has expired by `now` (only when a finite period is set). */
  private expired(rec: UsageRecord, now: number): boolean {
    if (this.periodMs <= 0) return false
    return now - new Date(rec.windowStart).getTime() >= this.periodMs
  }

  async add(ownerId: string, tokens: number, now = this.clock()): Promise<void> {
    const tok = clampTokens(tokens)
    const existing = this.records.get(ownerId)
    if (!existing) {
      this.records.set(ownerId, { ownerId, usedTokens: tok, periodTokens: tok, windowStart: new Date(now).toISOString() })
      return
    }
    // Lifetime always accumulates; the period resets first when the window has rolled.
    if (this.expired(existing, now)) {
      existing.periodTokens = 0
      existing.windowStart = new Date(now).toISOString()
    }
    existing.usedTokens += tok
    existing.periodTokens += tok
  }

  async get(ownerId: string, now = this.clock()): Promise<UsageRecord> {
    const existing = this.records.get(ownerId)
    if (!existing) return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: new Date(now).toISOString() }
    // Self-healing read: present the CURRENT window without mutating on a pure read.
    if (this.expired(existing, now)) {
      return { ...existing, periodTokens: 0, windowStart: new Date(now).toISOString() }
    }
    return { ...existing }
  }

  async snapshotAll(): Promise<UsageRecord[]> { return [...this.records.values()].map(r => ({ ...r })) }

  /** Snapshot every record (data only — for the dev-persistence wrapper's save). */
  snapshot(): UsageRecord[] { return [...this.records.values()].map(r => ({ ...r })) }
  /** Bulk-load records (data only — for the dev-persistence wrapper's boot hydrate). */
  hydrate(records: UsageRecord[]): void {
    for (const r of records) this.records.set(r.ownerId, { ...r })
  }
}
