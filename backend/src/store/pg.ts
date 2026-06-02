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

/** Every migration statement, in apply order. CREATE TABLE IF NOT EXISTS + idempotent
 *  ALTERs, so running this repeatedly (e.g. on every boot) is safe. */
const MIGRATIONS: readonly string[] = [
  CREATE_USERS_TABLE,
  ADD_EXTERNAL_ID,
  CREATE_SESSIONS_TABLE,
  CREATE_SESSIONS_OWNER_INDEX,
  CREATE_WORKFLOWS_TABLE,
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

/** The `pg` module shape createPgPool needs, and an injectable importer for it. */
type PgModule = { Pool: new (cfg: { connectionString: string }) => SqlClient }
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
  return new pg.Pool({ connectionString })
}
