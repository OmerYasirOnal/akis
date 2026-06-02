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

/** Idempotent DDL for the `users` table (the auth/oauth identity store). */
export const CREATE_USERS_TABLE = `
CREATE TABLE IF NOT EXISTS users (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL DEFAULT '',
  external_id   text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
)`

/** Idempotent migration for pre-existing user tables (added in the OAuth-identity fix). */
export const ADD_EXTERNAL_ID = `ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id text`

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
  version       integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
)`

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

/** Every migration statement, in apply order. CREATE TABLE IF NOT EXISTS + idempotent
 *  ALTERs, so running this repeatedly (e.g. on every boot) is safe. */
const MIGRATIONS: readonly string[] = [
  CREATE_USERS_TABLE,
  ADD_EXTERNAL_ID,
  CREATE_USERS_EXTERNAL_ID_UNIQUE,
  CREATE_SESSIONS_TABLE,
  CREATE_SESSIONS_OWNER_INDEX,
  CREATE_WORKFLOWS_TABLE,
  CREATE_VECTOR_CHUNKS_TABLE,
  CREATE_VECTOR_CHUNKS_TENANT_INDEX,
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

/** Fail fast (rather than block on the OS TCP default) when the DB is unreachable, so a
 *  bad/down DATABASE_URL feeds the boot fallback/fail-closed path promptly. */
const PG_CONNECT_TIMEOUT_MS = 5000

/** The runtime pool surface createPgPool needs: the SqlClient `query` plus the
 *  EventEmitter `on` (to attach the REQUIRED idle-client 'error' listener — see below). */
type PgPool = SqlClient & { on(event: 'error', listener: (err: Error) => void): unknown }
/** The `pg` module shape createPgPool needs, and an injectable importer for it. */
type PgModule = { Pool: new (cfg: { connectionString: string; connectionTimeoutMillis?: number }) => PgPool }
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
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: PG_CONNECT_TIMEOUT_MS })
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
