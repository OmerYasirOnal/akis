import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { buildServer } from '../../src/api/server.js'
import { JsonFileKeyStore } from '../../src/keys/KeyStore.js'
import { ProviderConfigError } from '../../src/agent/providers/createProvider.js'
import { CATALOG } from '../../src/agent/providers/catalog.js'
import type { OrchestratorServices } from '../../src/di/services.js'

/**
 * BOOT-PATH integration tests. The rest of the suite injects a pre-built `services`
 * (bypassing provider/keystore resolution) and runs under NODE_ENV=test (which forces the
 * mock in createProvider) — so it has historically MISSED real boot bugs that reached main:
 *   - KeyStore.get() threw on an undecryptable row → server boot crash-loop
 *   - a blank/whitespace AI_MODEL was forwarded to the provider API
 *   - a key configured ONLY in the KeyStore couldn't be resolved
 *
 * These tests PIN those behaviors by driving the REAL path: buildServer with `deps.services`
 * OMITTED (→ buildServices → createProvider runs for real) and a REAL JsonFileKeyStore over a
 * tmp file. Crucially, buildServices calls createProvider WITHOUT threading deps.env, so
 * createProvider reads the real `process.env` — under vitest that is NODE_ENV='test', which
 * forces the mock. To exercise the genuine production resolution we override
 * `process.env.NODE_ENV` (and scrub any host provider keys) here, restoring everything after
 * each test. (A probe confirmed that without this override the provider resolves to the mock
 * even with a real KeyStore key + deps.env NODE_ENV=production — i.e. these assertions would
 * be vacuous on the test-forced path.)
 */

// All provider/key-resolution env vars createProvider + hasRealProviderKey consult. Scrubbed
// before each test so a host-set key (CI/dev shell) can never leak into the real-path build
// and make a "no key" case accidentally resolve a provider.
const PROVIDER_ENV_KEYS = [
  'NODE_ENV',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'AI_API_KEY',
  'AI_PROVIDER',
  'AI_MODEL',
  'AKIS_ALLOW_MOCK',
] as const

const MASTER_A = 'a'.repeat(64) // 64 hex chars → a valid 32-byte AES master key
const MASTER_B = 'b'.repeat(64) // a DIFFERENT master → a row written under A no longer decrypts

let tmpDir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'akis-boot-'))
  // Snapshot then SCRUB the real process.env provider vars so the real createProvider path is
  // hermetic regardless of the host. Each test sets process.env.NODE_ENV itself.
  savedEnv = {}
  for (const k of PROVIDER_ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  // Restore the exact prior process.env (including keys that were unset → stay unset).
  for (const k of PROVIDER_ENV_KEYS) {
    const v = savedEnv[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const keyFile = (): string => join(tmpDir, 'keys.json')

const akisServices = (app: FastifyInstance): OrchestratorServices =>
  (app as FastifyInstance & { akisServices: OrchestratorServices }).akisServices

/** Write `anthropic` under master A, then reopen the SAME file under master B: the existing
 *  row can no longer be decrypted (rotated/lost AI_KEY_ENCRYPTION_KEY, or a corrupt restore).
 *  This is the exact shape that once crashed boot. */
function undecryptableKeyStore(): JsonFileKeyStore {
  const writer = new JsonFileKeyStore(keyFile(), MASTER_A)
  writer.set('anthropic', 'sk-ant-real-written-under-A')
  const reopened = new JsonFileKeyStore(keyFile(), MASTER_B)
  // Sanity: the row IS present (load() read it) but get() returns undefined (won't decrypt).
  expect(reopened.status('anthropic').configured).toBe(false)
  expect(reopened.get('anthropic')).toBeUndefined()
  return reopened
}

describe('INTEGRATION: real boot path (buildServices → createProvider + real KeyStore)', () => {
  // 1) Undecryptable KeyStore row + AKIS_ALLOW_MOCK → boot does NOT throw; it gracefully falls
  //    back to the keyless mock instead of crash-looping on the bad row, and /health is 200.
  it('an undecryptable KeyStore row does NOT crash boot when AKIS_ALLOW_MOCK is set (graceful keyless mock)', async () => {
    process.env.NODE_ENV = 'production'
    const keyStore = undecryptableKeyStore()
    let app!: FastifyInstance
    expect(() => {
      // AKIS_ALLOW_MOCK is honored at the buildServer gate: hasRealProviderKey(env, keyStore)
      // is false (the row won't decrypt → KeyStore.get returns undefined, not a throw), so the
      // keyless mock is injected. The old throwing KeyStore.get would have crashed here.
      // B1: a demo flag in production now requires the explicit AKIS_ALLOW_DEMO_IN_PROD ack
      // (else the boot fail-closes); with it the boot proceeds and /health reports mode:'demo'.
      app = buildServer({ keyStore, env: { AKIS_ALLOW_MOCK: '1', AKIS_ALLOW_DEMO_IN_PROD: '1', AUTH_JWT_SECRET: 's', NODE_ENV: 'production' } })
    }).not.toThrow()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, mode: 'demo' })
    // It fell back to the demo mock, not a real provider.
    expect(akisServices(app).provider.name).toBe('mock')
  })

  // 2) Same undecryptable KeyStore, but WITHOUT AKIS_ALLOW_MOCK in production → fail CLOSED with
  //    a CLEAR ProviderConfigError ("no provider configured"), NOT an opaque crypto error.
  it('an undecryptable KeyStore row WITHOUT AKIS_ALLOW_MOCK fails closed with a clear ProviderConfigError (not a crypto error)', () => {
    process.env.NODE_ENV = 'production'
    const keyStore = undecryptableKeyStore()
    let thrown: unknown
    try {
      buildServer({ keyStore, env: { AUTH_JWT_SECRET: 's', NODE_ENV: 'production' } })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ProviderConfigError)
    expect((thrown as Error).message).toMatch(/no ai provider configured/i)
    // Regression guard: the error is the clear config error, NOT the opaque GCM auth failure
    // that an unguarded KeyStore.get throw would have surfaced.
    expect((thrown as Error).message).not.toMatch(/unsupported state|unable to authenticate data/i)
    expect((thrown as Error).name).not.toBe('Error')
  })

  // 3) Keyless boot (empty KeyStore) with AKIS_ALLOW_MOCK + the explicit demo-in-prod ack →
  //    boots on the mock, /health is 200 { ok: true, mode: 'demo' } — the acknowledged
  //    `docker compose up` demo path (B1: production demo is opt-in + surfaced, never silent).
  it('keyless boot with AKIS_ALLOW_MOCK + AKIS_ALLOW_DEMO_IN_PROD serves the demo mock (GET /health 200 { ok: true, mode: demo })', async () => {
    process.env.NODE_ENV = 'production'
    const keyStore = new JsonFileKeyStore(keyFile(), MASTER_A) // empty file, never written to
    expect(keyStore.list()).toEqual([])
    const app = buildServer({ keyStore, env: { AKIS_ALLOW_MOCK: '1', AKIS_ALLOW_DEMO_IN_PROD: '1', AUTH_JWT_SECRET: 's', NODE_ENV: 'production' } })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, mode: 'demo' })
    expect(akisServices(app).provider.name).toBe('mock')
  })

  // 3b) B1 fail-closed: the SAME keyless demo flag in production WITHOUT the ack refuses to boot.
  it('keyless boot with AKIS_ALLOW_MOCK but NO ack fail-closes in production (B1)', () => {
    process.env.NODE_ENV = 'production'
    const keyStore = new JsonFileKeyStore(keyFile(), MASTER_A)
    expect(() => buildServer({ keyStore, env: { AKIS_ALLOW_MOCK: '1', AUTH_JWT_SECRET: 's', NODE_ENV: 'production' } }))
      .toThrow(/Refusing to boot|AKIS_ALLOW_DEMO_IN_PROD/)
  })

  // 4) A real, decryptable key in the KeyStore ONLY (no env key, no AKIS_ALLOW_MOCK) →
  //    createProvider resolves the real adapter from the KeyStore; boot succeeds, /health 200.
  it('a real key configured ONLY in the KeyStore resolves the real provider at boot (no env key, no mock)', async () => {
    process.env.NODE_ENV = 'production'
    const keyStore = new JsonFileKeyStore(keyFile(), MASTER_A)
    // Syntactically-real-looking Anthropic key. No network happens at boot — createProvider
    // just constructs the AnthropicProvider adapter from it.
    keyStore.set('anthropic', 'sk-ant-test-xxxx')
    expect(keyStore.get('anthropic')).toBe('sk-ant-test-xxxx') // round-trips (same master)
    let app!: FastifyInstance
    expect(() => {
      app = buildServer({ keyStore, env: { NODE_ENV: 'production', AUTH_JWT_SECRET: 's' } })
    }).not.toThrow()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true })
    // The provider was resolved from the KeyStore (real Anthropic adapter), NOT the mock.
    expect(akisServices(app).provider.name).toBe('anthropic')
  })

  // 5) A real key + a blank/whitespace AI_MODEL → boot succeeds AND the resolved model is the
  //    catalog default (never a blank "" / "  " forwarded to the provider API, which 400s).
  it('a blank/whitespace AI_MODEL falls back to the catalog default (never forwards a blank model)', async () => {
    process.env.NODE_ENV = 'production'
    process.env.AI_MODEL = '   ' // whitespace-only — the bug class that once reached the API
    const keyStore = new JsonFileKeyStore(keyFile(), MASTER_A)
    keyStore.set('anthropic', 'sk-ant-test-xxxx')
    let app!: FastifyInstance
    expect(() => {
      app = buildServer({ keyStore, env: { NODE_ENV: 'production', AUTH_JWT_SECRET: 's' } })
    }).not.toThrow()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const provider = akisServices(app).provider
    expect(provider.name).toBe('anthropic')
    // Observable resolved model: the catalog default, NOT the blank AI_MODEL.
    expect(provider.model).toBe(CATALOG.anthropic.defaultModel)
    expect(provider.model.trim()).not.toBe('')
  })
})
