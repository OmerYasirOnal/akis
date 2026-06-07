import type { SessionState, SessionStatus, SpecArtifact, CodeArtifact, ApprovalToken, VerifyToken, TestEvidence, BuildPassport, PublishRecord, ChatTurn } from '@akis/shared'
import type { SessionStore, SessionPatch, SessionSummary } from './SessionStore.js'
import type { SqlClient } from './pg.js'

/**
 * Postgres-backed session store (the durable seam behind SessionStore, selected when
 * DATABASE_URL is set). Pure SQL over an injected SqlClient — unit-testable with a fake
 * client and drop-in for a real `pg` Pool. Behavioural parity with MockSessionStore.
 *
 * The 4 structural gates are preserved here exactly as in the in-memory store:
 *  - the generic {@link update} builds its SET clause from a FIXED allowlist (the
 *    SessionPatch keys) and NEVER writes the `approval`/`verify_token` columns — a
 *    polluted patch carrying those keys is silently ignored;
 *  - ONLY {@link recordApproval}/{@link recordVerification} write the gate columns;
 *  - all three writes are optimistic-version locked (UPDATE ... WHERE id AND version),
 *    throwing the SAME messages MockSessionStore raises: `session <id> not found` when
 *    the row is absent (→ HTTP 404) and `version conflict: <cur> !== <expected>` when it
 *    exists at a different version.
 */
export class PgSessionStore implements SessionStore {
  constructor(private db: SqlClient) {}

  async create(s: SessionState): Promise<void> {
    // `base` (Phase B.5 edit-mode seed) is written ONLY here — it is set at session creation
    // by the controlled API path and is NOT in PATCH_COLUMNS, so it is immutable thereafter.
    await this.db.query(
      `INSERT INTO sessions (id, status, idea, owner_id, spec, approval, code, verify_token, test_evidence, passport, publish, chat, base, external_writes, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        s.id, s.status, s.idea, s.ownerId ?? null,
        toJson(s.spec), toJson(s.approval), toJson(s.code), toJson(s.verifyToken), toJson(s.testEvidence), toJson(s.passport),
        toJson(s.publish),
        toJson(s.chat),
        toJson(s.base),
        toJson(s.externalWrites),
        s.version,
      ],
    )
  }

  async get(id: string): Promise<SessionState | undefined> {
    const { rows } = await this.db.query('SELECT * FROM sessions WHERE id = $1', [id])
    return rows[0] ? toSession(rows[0]) : undefined
  }

  /**
   * FIXED allowlist of patchable columns — the SessionPatch keys, deliberately
   * EXCLUDING `approval`/`verifyToken` (the gate columns) and `id`/`version`. The SET
   * clause is built ONLY from these, so a stray `update({ approval })` can never write
   * a gate column. `ownerId` maps to the `owner_id` column.
   *
   * `testEvidence` is an ADDITIVE, NON-GATE column (`test_evidence` jsonb): it is on the
   * normal patch path (NOT a gate method), so this does NOT widen the gate-write surface
   * — the gate columns stay reachable only via recordApproval/recordVerification.
   */
  private static readonly PATCH_COLUMNS: ReadonlyArray<[keyof SessionPatch, string]> = [
    ['status', 'status'],
    ['idea', 'idea'],
    ['ownerId', 'owner_id'],
    ['spec', 'spec'],
    ['code', 'code'],
    ['testEvidence', 'test_evidence'],
    ['passport', 'passport'],
    // ADDITIVE, NON-GATE: the last publish-to-your-own-server attempt (`publish` jsonb). On the
    // normal patch path (NOT a gate method), so it does NOT widen the gate-write surface — EXACTLY
    // like `passport`/`testEvidence`. Without this entry the field is silently dropped on Postgres.
    ['publish', 'publish'],
    // ADDITIVE, NON-GATE (the F5 fix): the persisted AKIS-chat conversation (`chat` jsonb). On the
    // normal patch path — conversation text only, it can never write a gate column. Without this
    // entry the turns are silently dropped on Postgres and the FE rehydrate finds nothing.
    ['chat', 'chat'],
    // ADDITIVE, NON-GATE: proposed Jira/Confluence MCP writes (`external_writes` jsonb). On the
    // normal patch path — proposal content + lifecycle only, no token/gate column.
    ['externalWrites', 'external_writes'],
  ]

  /** Columns whose value is a nested object stored as jsonb (must be passed through toJson). */
  private static readonly JSON_COLUMNS = new Set(['spec', 'code', 'test_evidence', 'passport', 'publish', 'chat', 'external_writes'])

  async update(id: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState> {
    const sets: string[] = []
    const params: unknown[] = []
    for (const [key, col] of PgSessionStore.PATCH_COLUMNS) {
      if (!(key in patch)) continue
      const raw = patch[key]
      params.push(PgSessionStore.JSON_COLUMNS.has(col) ? toJson(raw) : (raw ?? null))
      sets.push(`${col} = $${params.length}`)
    }
    return this.optimisticUpdate(id, sets, params, expectedVersion)
  }

  /** Gate 1: the ONLY path that writes the `approval` column. */
  async recordApproval(id: string, approval: ApprovalToken, expectedVersion: number): Promise<SessionState> {
    return this.optimisticUpdate(id, ['approval = $1'], [toJson(approval)], expectedVersion)
  }

  /** Gate 3: the ONLY path that writes the `verify_token` column. */
  async recordVerification(id: string, token: VerifyToken, expectedVersion: number): Promise<SessionState> {
    return this.optimisticUpdate(id, ['verify_token = $1'], [toJson(token)], expectedVersion)
  }

  async listByOwner(ownerId: string): Promise<SessionState[]> {
    const { rows } = await this.db.query(
      'SELECT * FROM sessions WHERE owner_id = $1 ORDER BY created_at DESC',
      [ownerId],
    )
    return rows.map(toSession)
  }

  async listSummariesByOwner(ownerId: string): Promise<SessionSummary[]> {
    // PROJECTION (audit quick-win): the history list renders 4 fields, but SELECT * shipped the
    // FULL code/spec/passport/test_evidence jsonb (the entire generated app) per row, JSON-parsed
    // and discarded. Select only what is rendered + verify_token. `verified` keeps the REAL
    // isVerified semantics in JS — token present AND token.sessionId === id — NEVER a bare
    // verify_token-IS-NOT-NULL (which would falsely report a mismatched token as verified).
    const { rows } = await this.db.query(
      'SELECT id, idea, status, verify_token FROM sessions WHERE owner_id = $1 ORDER BY created_at DESC',
      [ownerId],
    )
    return rows.map(raw => {
      const r = raw as { id: unknown; idea: unknown; status: unknown; verify_token: unknown }
      const token = r.verify_token as { sessionId?: string } | null
      return {
        id: String(r.id),
        idea: String(r.idea),
        status: r.status as SessionState['status'],
        verified: token != null && token.sessionId === String(r.id),
      }
    })
  }

  /**
   * Shared optimistic-locked UPDATE. Always bumps `version` and locks on
   * `WHERE id = $ AND version = $expected RETURNING *`. On a miss (no row returned) a
   * follow-up SELECT disambiguates: no row at all throws `session <id> not found`, a row
   * at a different version throws `version conflict: <cur> !== <expected>` — matching
   * MockSessionStore so the two seams stay behaviourally interchangeable.
   */
  private async optimisticUpdate(id: string, sets: string[], setParams: unknown[], expectedVersion: number): Promise<SessionState> {
    const idIdx = setParams.length + 1
    const verIdx = setParams.length + 2
    const clauses = [...sets, 'version = version + 1']
    const { rows } = await this.db.query(
      `UPDATE sessions SET ${clauses.join(', ')} WHERE id = $${idIdx} AND version = $${verIdx} RETURNING *`,
      [...setParams, id, expectedVersion],
    )
    if (!rows[0]) {
      const { rows: cur } = await this.db.query('SELECT version FROM sessions WHERE id = $1', [id])
      // Distinguish the two miss cases to match MockSessionStore: no row at all →
      // "session <id> not found" (the route's sendError maps this to HTTP 404); a row at a
      // different version → "version conflict: <cur> !== <expected>" (an UNNAMED Error, so
      // it surfaces as HTTP 500 — identical to the in-memory store, so parity holds).
      if (!cur[0]) throw new Error(`session ${id} not found`)
      throw new Error(`version conflict: ${Number(cur[0].version)} !== ${expectedVersion}`)
    }
    return toSession(rows[0])
  }
}

/** Serialize a nested artifact/token to a jsonb value (or null when absent). Branded
 *  tokens serialize as plain JSON; the brand is a compile-time-only symbol with no
 *  runtime footprint, so it round-trips losslessly through jsonb. */
/** Serialize a value for a jsonb column. EXPLICITLY JSON.stringify (not pass-through): node-pg
 *  renders a JS OBJECT as json (so the object columns spec/code/passport/publish worked), but a JS
 *  ARRAY as a Postgres ARRAY LITERAL `{…}` — invalid for jsonb. `chat` (ChatTurn[]) is the first
 *  jsonb ARRAY column and hit exactly that ("invalid input syntax for type json", caught LIVE).
 *  Stringifying makes EVERY jsonb param an explicit JSON string — correct for objects and arrays
 *  alike; reads (toSession) get the parsed value back either way, so it's behaviour-preserving. */
export function toJson(v: unknown): unknown {
  return v == null ? null : JSON.stringify(v)
}

/** The raw `sessions` row shape as returned by Postgres (snake_case, jsonb columns
 *  already parsed by `pg` into JS objects). */
interface SessionRow {
  id: unknown; status: unknown; idea: unknown; owner_id: unknown
  spec: unknown; approval: unknown; code: unknown; verify_token: unknown; test_evidence: unknown; passport: unknown; publish: unknown; chat: unknown; base: unknown; external_writes: unknown; version: unknown
}

/**
 * Map a DB row back to SessionState. Optional fields are spread conditionally (never
 * set to `undefined`) to satisfy exactOptionalPropertyTypes.
 *
 * AUDITED CAST (single site): the gate tokens are nominal brands (a `unique symbol`
 * with NO runtime value), so a value read back from jsonb cannot carry the brand at
 * the type level even though it is structurally identical. This is the sole audited
 * `as unknown as ApprovalToken / VerifyToken` re-cast, confined to this row mapper —
 * it re-attaches the brand to a token that was genuinely persisted via the gate
 * methods. `isVerified()` therefore holds after `get()`/`listByOwner()`.
 */
function toSession(raw: Record<string, unknown>): SessionState {
  const r = raw as unknown as SessionRow
  return {
    id: String(r.id),
    status: r.status as SessionStatus,
    idea: String(r.idea),
    version: Number(r.version),
    ...(r.owner_id != null ? { ownerId: String(r.owner_id) } : {}),
    ...(r.spec != null ? { spec: r.spec as SpecArtifact } : {}),
    ...(r.code != null ? { code: r.code as CodeArtifact } : {}),
    // ADDITIVE, NON-GATE: plain jsonb round-trip (no brand to re-attach), so no audited cast.
    ...(r.test_evidence != null ? { testEvidence: r.test_evidence as TestEvidence } : {}),
    // ADDITIVE, NON-GATE: the signed Build Passport round-trips as plain jsonb (the Ed25519
    // signature lives INSIDE it; nothing to re-attach), so it persists on Postgres too.
    ...(r.passport != null ? { passport: r.passport as BuildPassport } : {}),
    // ADDITIVE, NON-GATE: the last publish-to-your-own-server attempt round-trips as plain jsonb
    // (data only — no capability; the SSH key never enters this record), so the FE PublishButton
    // surfaces the live URL / honest failure reason on Postgres too, not just the in-memory store.
    ...(r.publish != null ? { publish: r.publish as PublishRecord } : {}),
    // ADDITIVE, NON-GATE (the F5 fix): the persisted conversation round-trips as plain jsonb
    // (text only — no capability), so the FE thread rehydrate works on Postgres too.
    ...(r.chat != null ? { chat: r.chat as ChatTurn[] } : {}),
    // ADDITIVE, NON-GATE, set-only-at-create: the Phase B.5 edit-mode seed round-trips as
    // plain jsonb (data only — no capability), so edit-mode builds survive a Pg restart.
    ...(r.base != null ? { base: r.base as NonNullable<SessionState['base']> } : {}),
    // ADDITIVE, NON-GATE: proposed external writes round-trip as plain jsonb (content + lifecycle
    // only, no token), so the human-confirm flow survives a Pg restart.
    ...(r.external_writes != null ? { externalWrites: r.external_writes as NonNullable<SessionState['externalWrites']> } : {}),
    ...(r.approval != null ? { approval: r.approval as unknown as ApprovalToken } : {}),
    ...(r.verify_token != null ? { verifyToken: r.verify_token as unknown as VerifyToken } : {}),
  }
}
