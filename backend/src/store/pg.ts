/**
 * Shared Postgres seam for the self-host persistence path.
 *
 * Home of the {@link SqlClient} interface (the minimal `query(text, params?) → { rows }`
 * shape every Pg store depends on, trivially faked in tests), a LAZY `pg` pool
 * factory, and the idempotent schema migrations. `pg` is shipped as a `dependency`
 * (the self-host image needs it), but it is imported LAZILY (via a non-literal
 * specifier) and only when DATABASE_URL is set — so it is never loaded on the
 * in-memory default path, tsc never resolves it at build time, and a pruned/library
 * install WITHOUT `pg` still builds and runs (the factory throws a clear error only if
 * a connection is actually attempted without it).
 */

/** The minimal client shape the Pg stores need — satisfied by a `pg` Pool/Client
 *  (`query(text, params) → { rows }`) and trivially faked in tests. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>
  /** Optional pool teardown for graceful shutdown — a `pg.Pool` provides `.end()`,
   *  which drains idle clients and closes sockets. Optional so the in-memory fakes
   *  (and any non-pool client) need not implement it. */
  end?(): Promise<void>
}

/** Idempotent DDL for the `users` table (the auth/oauth identity store). `avatar_url` is the
 *  provider profile picture (OAuth login projection). `email_verified`/`status` record whether
 *  the email is provider-verified and the account is active — set TRUE/'active' for OAuth
 *  sign-ins (the provider already verified the address). Defaults keep password accounts on the
 *  existing behavior (no flag set ⇒ false/active baseline). */
export const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL DEFAULT '',
  external_id   text UNIQUE,
  token_version integer NOT NULL DEFAULT 0,
  tier          text,
  stripe_customer_id text,
  avatar_url    text,
  email_verified boolean NOT NULL DEFAULT false,
  -- VALUE-DOMAIN NOTE: the canonical/live DB types this column as a \`user_status\` ENUM
  -- {pending_verification, active, disabled, deleted}; fresh DBs use \`text\` + the inline CHECK
  -- below to stay within that SAME value-domain. An inline column CHECK applies ONLY when the
  -- column is freshly created here — so it is a no-op on the enum DB (the column already exists)
  -- and a guard on fresh text DBs. The type difference is intentional and safe because \`status\`
  -- is currently WRITE-ONLY: PgUserStore writes 'active' on OAuth INSERT but never SELECTs it back
  -- into AuthUser, so the text-vs-enum mismatch never crosses the row↔user mapper.
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_verification','active','disabled','deleted')),
  -- The provider used for the MOST-RECENT login (drives the FE "Signed in via …" badge). NULL for
  -- password accounts and for rows written before this column; CHECK keeps it in the AuthProvider domain.
  last_login_provider text CHECK (last_login_provider IN ('github','google','password')),
  created_at    timestamptz NOT NULL DEFAULT now()
)`

/** Idempotent migration for pre-existing user tables (added in the OAuth-identity fix). */
export const ADD_EXTERNAL_ID = `ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id text`

/** Idempotent migration: token revocation (audit gap) — session JWTs carry the version
 *  they were signed with; a bump invalidates every outstanding token for the user. */
export const ADD_TOKEN_VERSION = `ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0`

/** Idempotent migration: paid-tier billing — the user's tier ('pro' when subscribed; NULL/absent ⇒
 *  free) + their Stripe customer id (set by the checkout webhook, reused for the billing portal). */
export const ADD_USER_TIER = `ALTER TABLE users ADD COLUMN IF NOT EXISTS tier text`
export const ADD_USER_STRIPE_CUSTOMER = `ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id text`

/** Idempotent migration: OAuth login projection — the provider avatar URL (nullable; only
 *  OAuth users that exposed a picture have one). */
export const ADD_USER_AVATAR_URL = `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text`
/** Idempotent migration: whether the email is provider-verified, and the account status.
 *  Set TRUE/'active' on an OAuth sign-in (the provider already verified the email). Defaults
 *  preserve existing password-account behavior on an upgraded DB. */
export const ADD_USER_EMAIL_VERIFIED = `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false`
/** Idempotent migration for the account status. VALUE-DOMAIN NOTE (see CREATE_USERS_TABLE):
 *  the canonical/live DB types this as a \`user_status\` ENUM {pending_verification, active,
 *  disabled, deleted}; fresh/upgraded text DBs use \`text\` + this inline CHECK to stay in the SAME
 *  value-domain. ADD COLUMN IF NOT EXISTS short-circuits when the column already exists, so the
 *  CHECK is applied ONLY when the column is freshly added — a no-op (no new constraint) on a DB that
 *  already has \`status\` (text OR enum), which is what keeps the idempotent re-run safe. The column
 *  is currently WRITE-ONLY (never SELECTed back into AuthUser), so the text-vs-enum type difference
 *  is intentional and safe. */
export const ADD_USER_STATUS = `ALTER TABLE users ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('pending_verification','active','disabled','deleted'))`
/** Idempotent migration: the provider used for the most-recent login (drives the FE login badge).
 *  Nullable (password accounts + pre-existing rows have none); CHECK keeps it in the AuthProvider
 *  value-domain. The inline CHECK only applies when the column is freshly added (ADD COLUMN IF NOT
 *  EXISTS short-circuits otherwise), so re-running is a safe no-op. */
export const ADD_USER_LAST_LOGIN_PROVIDER = `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_provider text CHECK (last_login_provider IN ('github','google','password'))`

/**
 * Idempotent UNIQUE index on external_id. The fresh-table inline `external_id text UNIQUE`
 * only protects DBs created from CREATE_USERS_TABLE; a users table that PRE-DATES the
 * column gets it via ADD_EXTERNAL_ID (ADD COLUMN IF NOT EXISTS), which adds NO constraint —
 * so without this index an upgraded DB would allow duplicate OAuth identities, defeating
 * PgUserStore.upsertOAuth's 23505 race-recovery and the in-memory store's per-identity
 * uniqueness. PARTIAL (WHERE external_id IS NOT NULL) so password-only users (NULL
 * external_id) are unaffected. The name matches the inline constraint's Postgres auto-name
 * (`<table>_<column>_key`), so on a fresh DB the index already exists and this is a no-op.
 */
export const CREATE_USERS_EXTERNAL_ID_UNIQUE =
  `CREATE UNIQUE INDEX IF NOT EXISTS users_external_id_key ON users (external_id) WHERE external_id IS NOT NULL`

/**
 * Idempotent DDL for the `sessions` table. The gate-bearing fields (`approval`,
 * `verify_token`) and the artifacts (`spec`, `code`) are jsonb; `version` carries the
 * optimistic lock. `owner_id` powers per-user build history (indexed for listByOwner).
 * `test_evidence` is the ADDITIVE, NON-GATE structured test evidence (jsonb), written on
 * the normal patch path — NOT a gate column.
 */
export const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id            text PRIMARY KEY,
  status        text NOT NULL,
  idea          text NOT NULL,
  owner_id      text,
  spec          jsonb,
  approval      jsonb,
  code          jsonb,
  verify_token  jsonb,
  test_evidence jsonb,
  passport      jsonb,
  publish       jsonb,
  base          jsonb,
  external_writes jsonb,
  version       integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
)`

/** Idempotent migration for pre-existing sessions tables: add the additive, NON-GATE
 *  `test_evidence` jsonb column (no constraint, nullable) so an upgraded DB persists evidence. */
export const ADD_TEST_EVIDENCE = `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS test_evidence jsonb`

/** Idempotent migration for pre-existing sessions tables: add the additive, NON-GATE, set-only-
 *  at-create `base` jsonb column (Phase B.5 edit-mode seed) so an upgraded DB persists it. */
export const ADD_BASE = `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS base jsonb`

/** Idempotent migration for pre-existing sessions tables: add the additive, NON-GATE
 *  `passport` jsonb column (nullable) so an upgraded DB persists the signed Build Passport. */
export const ADD_PASSPORT = `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS passport jsonb`

/** Idempotent migration for pre-existing sessions tables: add the additive, NON-GATE `publish`
 *  jsonb column (nullable) so an upgraded DB persists the last publish-to-your-own-server attempt
 *  (live URL / honest failure reason) — without it the field is silently dropped on Postgres. */
export const ADD_PUBLISH = `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS publish jsonb`

/** Idempotent migration (the F5 fix): add the additive, NON-GATE `chat` jsonb column (nullable) —
 *  the persisted AKIS-chat conversation bound to the session, so the thread survives a
 *  refresh/another device. Without it the field is silently dropped on Postgres and the FE
 *  rehydrate would find nothing. */
export const ADD_CHAT = `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chat jsonb`

/** Idempotent migration: add the additive, NON-GATE `external_writes` jsonb column (nullable) — the
 *  proposed Jira/Confluence MCP writes for a session. Without it the field is silently dropped on
 *  Postgres. */
export const ADD_EXTERNAL_WRITES = `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS external_writes jsonb`

/** Newest-first per-owner history listing (listByOwner) is the hot read path. */
export const CREATE_SESSIONS_OWNER_INDEX = `CREATE INDEX IF NOT EXISTS sessions_owner_id_idx ON sessions (owner_id, created_at DESC)`

/**
 * Idempotent DDL for the `workflows` table. Workflows are VERSIONED: a new row is
 * appended per save (PRIMARY KEY is the (id, version) pair), so an in-flight run that
 * captured version N is never mutated. `agents`/`gate_policy` are jsonb; `rag`/`rerank`
 * are nullable booleans (a tri-state: unset vs explicit false vs true).
 */
export const CREATE_WORKFLOWS_TABLE = `
CREATE TABLE IF NOT EXISTS workflows (
  id             text NOT NULL,
  version        integer NOT NULL,
  name           text NOT NULL,
  agents         jsonb NOT NULL,
  gate_policy    jsonb,
  iterate_budget integer,
  rag            boolean,
  rerank         boolean,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
)`

/**
 * Idempotent DDL for the `vector_chunks` table — the PERSISTENT RAG corpus (so it survives
 * restart instead of being re-indexed from scratch). NO pgvector extension: the embedding is a
 * plain `double precision[]` and ranking is brute-force cosine done in JS after a tenant fetch
 * (the single-user corpus is small). `id` is the contentHash → idempotent upsert (ON CONFLICT).
 * `chunk`/`meta` are jsonb (round-trip the KnowledgeChunk + ChunkMeta losslessly). The tenancy
 * columns (`user_id`, `session_id`, `source`, `source_id`) are broken out for indexed scans and
 * mirror ChunkMeta. `seq` (a BIGSERIAL) preserves insertion order so hydration rebuilds the
 * in-memory index in the SAME order, keeping score-tie ordering identical to MemoryVectorStore.
 */
export const CREATE_VECTOR_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS vector_chunks (
  id          text PRIMARY KEY,
  user_id     text NOT NULL,
  session_id  text NOT NULL,
  source      text NOT NULL,
  source_id   text NOT NULL,
  agent       text,
  created_at  text NOT NULL,
  vector      double precision[] NOT NULL,
  chunk       jsonb NOT NULL,
  meta        jsonb NOT NULL,
  seq         bigserial NOT NULL
)`

/** Tenancy scan index: the candidate fetch / right-to-forget filter on (user_id, session_id). */
export const CREATE_VECTOR_CHUNKS_TENANT_INDEX =
  `CREATE INDEX IF NOT EXISTS vector_chunks_tenant_idx ON vector_chunks (user_id, session_id)`

/**
 * Idempotent DDL for the `user_usage` table — the SHARED per-user token-usage ledger behind the
 * per-user quota (multi-tenant safety). `owner_id` PRIMARY KEY powers the UPSERT in PgUsageStore.
 * `used_tokens`/`period_tokens` are `bigint` because lifetime token counts exceed int4 (and
 * node-pg returns bigint as a STRING — PgUsageStore coerces with Number(...)). `window_start`
 * tracks the current budget period (rolled lazily by the UPSERT cutoff). Token COUNTS are not
 * secrets, so no encryption — just numbers, like AgentMetrics.
 */
export const CREATE_USER_USAGE_TABLE = `
CREATE TABLE IF NOT EXISTS user_usage (
  owner_id      text PRIMARY KEY,
  used_tokens   bigint NOT NULL DEFAULT 0,
  period_tokens bigint NOT NULL DEFAULT 0,
  window_start  timestamptz NOT NULL DEFAULT now()
)`

/**
 * APPEND-ONLY audit ledger (Move 3a): one durable row per emitted bus event, so a build's full
 * chronological trail survives a restart in a QUERYABLE form (vs. the in-memory replay buffer / the
 * dev bus-snapshot file). UNIQUE(session_id, seq) makes the writer idempotent — a replayed event
 * with the same seq is a no-op (ON CONFLICT DO NOTHING), never a duplicate. Read owner-scoped via
 * the session. Holds NO gate capability — pure observability/provenance evidence.
 */
export const CREATE_AUDIT_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS audit_events (
  id          bigserial PRIMARY KEY,
  session_id  text NOT NULL,
  seq         integer NOT NULL,
  ts          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  payload     jsonb,
  UNIQUE (session_id, seq)
)`
export const CREATE_AUDIT_EVENTS_SESSION_INDEX =
  `CREATE INDEX IF NOT EXISTS audit_events_session_idx ON audit_events (session_id, seq)`

/** Every migration statement, in apply order. CREATE TABLE IF NOT EXISTS + idempotent
 *  ALTERs, so running this repeatedly (e.g. on every boot) is safe. */
const MIGRATIONS: readonly string[] = [
  CREATE_USERS_TABLE,
  ADD_EXTERNAL_ID,
  ADD_TOKEN_VERSION,
  ADD_USER_TIER,
  ADD_USER_STRIPE_CUSTOMER,
  ADD_USER_AVATAR_URL,
  ADD_USER_EMAIL_VERIFIED,
  ADD_USER_STATUS,
  ADD_USER_LAST_LOGIN_PROVIDER,
  CREATE_USERS_EXTERNAL_ID_UNIQUE,
  CREATE_SESSIONS_TABLE,
  ADD_TEST_EVIDENCE,
  ADD_PASSPORT,
  ADD_PUBLISH,
  ADD_CHAT,
  ADD_BASE,
  ADD_EXTERNAL_WRITES,
  CREATE_SESSIONS_OWNER_INDEX,
  CREATE_WORKFLOWS_TABLE,
  CREATE_VECTOR_CHUNKS_TABLE,
  CREATE_VECTOR_CHUNKS_TENANT_INDEX,
  CREATE_USER_USAGE_TABLE,
  CREATE_AUDIT_EVENTS_TABLE,
  CREATE_AUDIT_EVENTS_SESSION_INDEX,
]

/**
 * Ensure the schema exists. Runs each idempotent migration in order over the injected
 * client, so it is safe to call on every boot and unit-testable with a fake SqlClient.
 */
export async function runMigrations(client: SqlClient): Promise<void> {
  for (const sql of MIGRATIONS) {
    await client.query(sql)
  }
}

/** Outcome of {@link ensurePgVectorColumn}: whether the real `vector` type is now active on the
 *  column (extension present + ALTER applied) or the deployment stays on the `double precision[]`
 *  fallback (extension unavailable). Surfaced so callers can log it and tests can assert/skip. */
export interface PgVectorColumnResult {
  enabled: boolean
}

/**
 * GUARDED upgrade of `vector_chunks.vector` from the portable `double precision[]` to a real,
 * indexable `vector(dim)` (pgvector) typed to the ACTIVE embedding dimension.
 *
 * pgvector is the NICE-TO-HAVE here (there is no scale yet), so this is strictly best-effort and
 * MUST NEVER break a deployment whose Postgres lacks the extension (plain `postgres:16`, a managed
 * DB without pgvector, CI without it): if `CREATE EXTENSION vector` is unavailable, we DETECT it
 * and leave the column as `double precision[]` — today's behavior, fully functional — returning
 * `{ enabled: false }`. The whole function is wrapped so ANY pgvector-side error degrades to the
 * fallback rather than failing boot.
 *
 * When the extension IS present:
 *   1. `CREATE EXTENSION IF NOT EXISTS vector`.
 *   2. If the column is not already a `vector`, `ALTER … TYPE vector(dim) USING vector::vector(dim)`
 *      (pgvector registers the array→vector cast; an empty/fresh table converts trivially).
 *   3. Best-effort an ivfflat ANN index for cosine (`vector_cosine_ops`). Index creation is
 *      separately guarded so a quirk there still leaves the column upgraded.
 *
 * `dim` is derived from the active embedder (activeEmbeddingDim) so the column matches what is
 * actually stored (default keyless = 256; OpenAI text-embedding-3-small = 1536). Idempotent:
 * re-running detects the column is already `vector` and the index already exists, both no-ops.
 *
 * The PgVectorStore read path is unchanged either way — it ranks via the in-memory delegate, and
 * its `parseVector` already handles both the `{…}` array literal and the `[…]` pgvector literal.
 */
export async function ensurePgVectorColumn(client: SqlClient, dim: number): Promise<PgVectorColumnResult> {
  // The dim is interpolated into DDL, so coerce to a safe positive integer (it always comes from
  // the catalog/Local embedder, but never trust a number flowing into SQL text). An invalid dim
  // degrades to the fallback rather than emitting malformed DDL.
  const n = Math.trunc(dim)
  if (!Number.isFinite(n) || n <= 0) return { enabled: false }
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
  } catch {
    // Extension unavailable (not installed / insufficient privilege) → keep double precision[].
    return { enabled: false }
  }
  try {
    // Is the column already a `vector`? (information_schema reports it as USER-DEFINED.)
    // Schema-qualify to the active schema so a same-named column in another schema can't be read.
    const { rows } = await client.query(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'vector_chunks' AND column_name = 'vector'
         AND table_schema = current_schema()`,
    )
    const udt = rows[0]?.udt_name
    if (udt !== 'vector') {
      // Convert in place. pgvector registers a cast from real[]/double precision[] to vector, so an
      // existing double precision[] corpus converts row-by-row; a fresh/empty table is a no-op cast.
      await client.query(
        `ALTER TABLE vector_chunks ALTER COLUMN vector TYPE vector(${n}) USING vector::vector(${n})`,
      )
    }
    // DEAD-INDEX REMOVAL (audit quick-win): an ivfflat ANN index used to be created here, but NO
    // query ever used it — ranking happens entirely in JS (zero `<=>`/vector_cosine SQL anywhere),
    // so it was pure write-tax (maintained on every upsert/delete) plus shared_buffers pressure on
    // a small box. Dropped best-effort (IF EXISTS — also reclaims space on a box that already
    // built it); when ranking moves into pgvector SQL (the bigger-bet refactor), recreate it
    // TOGETHER with the query that uses it.
    try {
      await client.query('DROP INDEX IF EXISTS vector_chunks_vector_ann_idx')
    } catch {
      // Drop failed (permissions/odd build) — harmless, the column upgrade stands.
    }
    return { enabled: true }
  } catch {
    // Any ALTER-side failure (e.g. a pre-existing mixed-dimension corpus that can't cast) →
    // leave the portable double precision[] column in place rather than break boot.
    return { enabled: false }
  }
}

/** Fail fast (rather than block on the OS TCP default) when the DB is unreachable, so a
 *  bad/down DATABASE_URL feeds the boot fallback/fail-closed path promptly. */
const PG_CONNECT_TIMEOUT_MS = 5000

/** The runtime pool surface createPgPool needs: the SqlClient `query` plus the
 *  EventEmitter `on` (to attach the REQUIRED idle-client 'error' listener — see below). */
type PgPool = SqlClient & { on(event: 'error', listener: (err: Error) => void): unknown }
/** The `pg` module shape createPgPool needs, and an injectable importer for it. */
type PgModule = { Pool: new (cfg: { connectionString: string; connectionTimeoutMillis?: number; max?: number; idleTimeoutMillis?: number }) => PgPool }
export type PgImporter = () => Promise<PgModule>

/** Default importer: a NON-LITERAL specifier so tsc never resolves `pg` at build time
 *  (a pruned/library install without `pg` still builds) and it loads lazily, only when a
 *  pool is actually created (DATABASE_URL set). */
const defaultImportPg: PgImporter = () => {
  const spec = 'pg'
  return import(spec) as unknown as Promise<PgModule>
}

/**
 * Lazily import `pg` and create a connection Pool. `pg` is shipped as a dependency (the
 * self-host image needs it) but loaded lazily via the default NON-LITERAL importer, so
 * tsc never resolves it at build time and a pruned/library install without `pg` still
 * builds. Throws a clear, actionable error when the import fails. `importPg` is injectable
 * ONLY so the missing-`pg` error path is deterministically testable (the test env can't
 * rely on `pg` being absent now that it is a shipped dependency).
 */
export async function createPgPool(connectionString: string, importPg: PgImporter = defaultImportPg): Promise<SqlClient> {
  let pg: PgModule
  try {
    pg = await importPg()
  } catch {
    throw new Error('DATABASE_URL is set but the `pg` package is not installed (run: pnpm -C backend add pg)')
  }
  // POOL CAP (audit quick-win): node-pg's default `max` is 10 server-side backends (~5-10MB RSS
  // each) — far past what this single-operator, ~1-query-per-request workload ever uses, and real
  // memory on a small shared box. 4 is generous (zero transactions / zero pool.connect() fan-out
  // in this codebase, so a saturated small pool just queues briefly; the connect timeout below
  // still fails fast). idleTimeoutMillis returns idle backends to the DB instead of pinning them
  // for the process lifetime. AKIS_PG_POOL_MAX overrides for bigger deployments.
  const envMax = Number(process.env.AKIS_PG_POOL_MAX)
  const max = Number.isInteger(envMax) && envMax > 0 ? envMax : 4
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS, max, idleTimeoutMillis: 10_000 })
  // node-postgres emits an 'error' event on behalf of IDLE clients when a backend
  // connection dies (DB restart, failover, admin terminate, idle timeout). A `pg.Pool`
  // is an EventEmitter, so an 'error' with NO listener throws and becomes an UNCAUGHT
  // exception that kills the whole process post-boot — the pg docs require this listener.
  // It is recoverable: the pool discards the dead client and opens a fresh one on the
  // next query, so we log and continue rather than crash.
  pool.on('error', err => {
    // eslint-disable-next-line no-console
    console.error('pg pool idle-client error (connection will be recycled):', err.message)
  })
  return pool
}
