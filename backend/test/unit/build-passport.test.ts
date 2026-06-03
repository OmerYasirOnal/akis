/**
 * Build Passport + evidenceDigest — the THESIS "portable trust" deliverable.
 *
 * Two layers, both ADDITIVE to the SACRED fail-closed mint rule (a VerifyToken is
 * minted ONLY on a genuine ≥1-test pass):
 *   1. evidenceDigest — a length-prefixed, collision-resistant digest of the STRUCTURED
 *      TestEvidence, carried on the branded VerifyToken (same rigor as codeDigest). It is
 *      DERIVED from the evidence and PURELY additive: it never relaxes the pass condition.
 *   2. Build Passport — a durable, Ed25519-signed (node:crypto) artifact attesting the
 *      already-minted facts {sessionId, testsRun, codeDigest, evidenceDigest, issuedAt}.
 *      The orchestrator can only TRUST (verify a signature), never forge.
 */
import { describe, it, expect } from 'vitest'
import type { TestEvidence } from '@akis/shared'
import { digestEvidence } from '../../src/verify/digest.js'
import { verifyWith } from '../helpers/tokens.js'
import {
  signPassport,
  verifyPassport,
  generatePassportKeypair,
  loadOrCreatePassportSigner,
  type BuildPassport,
} from '../../src/verify/passport.js'

const FILES = [{ filePath: 'a.ts', content: 'x' }]

function evidence(over: Partial<TestEvidence> = {}): TestEvidence {
  return {
    testsRun: 2,
    passed: true,
    durationMs: 12,
    bdd: { built: 2, run: 2, passed: 2, failed: 0, skipped: 0, durationMs: 12 },
    e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
    scenarios: [
      { name: 'adds a todo', suite: 'bdd', passed: true },
      { name: 'removes a todo', suite: 'bdd', passed: true },
    ],
    ...over,
  }
}

// ── Layer 1: evidenceDigest (tamper-evident structured evidence) ────────────────
describe('digestEvidence — collision-resistant digest of structured evidence', () => {
  it('is stable for the same evidence', () => {
    expect(digestEvidence(evidence())).toBe(digestEvidence(evidence()))
  })
  it('changes when the testsRun count changes (tamper-evident)', () => {
    expect(digestEvidence(evidence({ testsRun: 2 }))).not.toBe(digestEvidence(evidence({ testsRun: 3 })))
  })
  it('changes when a scenario name is mutated (tamper-evident)', () => {
    const a = evidence()
    const b = evidence({ scenarios: [{ name: 'HACKED', suite: 'bdd', passed: true }, { name: 'removes a todo', suite: 'bdd', passed: true }] })
    expect(digestEvidence(a)).not.toBe(digestEvidence(b))
  })
  it('changes when the pass outcome flips (tamper-evident)', () => {
    expect(digestEvidence(evidence({ passed: true }))).not.toBe(digestEvidence(evidence({ passed: false })))
  })
  it('is collision-resistant via length-prefixing (boundary-ambiguous names do not collide)', () => {
    const a = evidence({ scenarios: [{ name: 'a', suite: 'bdd', passed: true }, { name: 'bc', suite: 'bdd', passed: true }] })
    const b = evidence({ scenarios: [{ name: 'ab', suite: 'bdd', passed: true }, { name: 'c', suite: 'bdd', passed: true }] })
    expect(digestEvidence(a)).not.toBe(digestEvidence(b))
  })
})

describe('evidenceDigest is bound onto the VerifyToken (additive, never relaxes mint)', () => {
  it('a verified ≥1-test pass carries an evidenceDigest on the token', async () => {
    const token = await verifyWith('s1', FILES, { testsRun: 2, passed: true })
    expect(token).not.toBeNull()
    expect(typeof token!.evidenceDigest).toBe('string')
    expect(token!.evidenceDigest.length).toBeGreaterThan(0)
    // The codeDigest is ALSO still bound (the existing tamper-evidence is untouched).
    expect(typeof token!.codeDigest).toBe('string')
  })

  it('the bound evidenceDigest matches digestEvidence over the run that produced it', async () => {
    // The mock runner synthesizes one BDD scenario per configured test, all passing.
    const token = await verifyWith('s1', FILES, { testsRun: 2, passed: true })
    const expected = digestEvidence(evidence({ scenarios: [
      { name: 'mock scenario 1', suite: 'bdd', passed: true },
      { name: 'mock scenario 2', suite: 'bdd', passed: true },
    ], durationMs: 0, bdd: { built: 2, run: 2, passed: 2, failed: 0, skipped: 0, durationMs: 0 } }))
    expect(token!.evidenceDigest).toBe(expected)
  })

  // GATE-SAFETY: the evidenceDigest is DERIVED + additive — it must NOT change the
  // fail-closed pass condition. A 0-test / failed run still mints NO token.
  it('mint still returns null for a 0-test run (evidenceDigest never relaxes fail-closed)', async () => {
    expect(await verifyWith('s1', FILES, { testsRun: 0, passed: true })).toBeNull()
  })
  it('mint still returns null for a run that ran tests but failed', async () => {
    expect(await verifyWith('s1', FILES, { testsRun: 5, passed: false })).toBeNull()
  })
})

// ── Layer 2: signed Build Passport ──────────────────────────────────────────────
describe('Build Passport — Ed25519 sign + verify', () => {
  const keypair = generatePassportKeypair()

  function verifiedFacts() {
    return { sessionId: 's1', testsRun: 2, codeDigest: 'codeABC', evidenceDigest: 'evd123' }
  }

  it('signs already-minted facts and a correct passport VERIFIES against the public key', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    expect(passport.sessionId).toBe('s1')
    expect(passport.testsRun).toBe(2)
    expect(passport.codeDigest).toBe('codeABC')
    expect(passport.evidenceDigest).toBe('evd123')
    expect(typeof passport.issuedAt).toBe('string')
    expect(typeof passport.signature).toBe('string')
    expect(passport.publicKey).toBe(keypair.publicKey)
    expect(verifyPassport(passport, keypair.publicKey)).toBe(true)
  })

  it('verifies against the publicKey embedded on the passport (read-path convenience)', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    expect(verifyPassport(passport)).toBe(true)
  })

  it('a tampered testsRun FAILS verification', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    const forged: BuildPassport = { ...passport, testsRun: 9999 }
    expect(verifyPassport(forged, keypair.publicKey)).toBe(false)
  })

  it('a tampered codeDigest FAILS verification', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    const forged: BuildPassport = { ...passport, codeDigest: 'TAMPERED' }
    expect(verifyPassport(forged, keypair.publicKey)).toBe(false)
  })

  it('a tampered evidenceDigest FAILS verification', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    const forged: BuildPassport = { ...passport, evidenceDigest: 'TAMPERED' }
    expect(verifyPassport(forged, keypair.publicKey)).toBe(false)
  })

  it('a tampered signature FAILS verification', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    // Flip a char in the base64 signature (kept same length).
    const sig = passport.signature
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    expect(verifyPassport({ ...passport, signature: flipped }, keypair.publicKey)).toBe(false)
  })

  it('verification FAILS against a DIFFERENT public key (wrong issuer)', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    const other = generatePassportKeypair()
    expect(verifyPassport(passport, other.publicKey)).toBe(false)
  })

  it('a malformed/garbage signature never throws — it returns false', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    expect(verifyPassport({ ...passport, signature: 'not-base64!!!' }, keypair.publicKey)).toBe(false)
    expect(verifyPassport({ ...passport, signature: '' }, keypair.publicKey)).toBe(false)
  })

  it('verification FAILS against a malformed public key (never throws)', () => {
    const passport = signPassport(verifiedFacts(), keypair)
    expect(verifyPassport(passport, 'not-a-key')).toBe(false)
  })
})

// ── Key handling: read from env; persist a clearly-dev keypair when unset; no leak ──
describe('passport signer key handling (env / dev keypair) — NEVER leaks the private key', () => {
  it('uses a configured Ed25519 private key from env (round-trips sign→verify)', () => {
    const seed = generatePassportKeypair()
    const signer = loadOrCreatePassportSigner({ AKIS_PASSPORT_PRIVATE_KEY: seed.privateKey })
    const passport = signPassport({ sessionId: 's1', testsRun: 1, codeDigest: 'c', evidenceDigest: 'e' }, signer)
    expect(signer.dev).toBe(false)
    expect(verifyPassport(passport, signer.publicKey)).toBe(true)
  })

  it('generates+persists a clearly-DEV keypair when env is unset (and reuses it)', () => {
    const store = new Map<string, string>()
    const persist = { get: (k: string) => store.get(k), set: (k: string, v: string) => { store.set(k, v) } }
    const a = loadOrCreatePassportSigner({}, persist)
    expect(a.dev).toBe(true)
    // Persisted, so a second call reuses the SAME key (stable passport publicKey across boots).
    const b = loadOrCreatePassportSigner({}, persist)
    expect(b.publicKey).toBe(a.publicKey)
    const passport = signPassport({ sessionId: 's1', testsRun: 1, codeDigest: 'c', evidenceDigest: 'e' }, b)
    expect(verifyPassport(passport, a.publicKey)).toBe(true)
  })

  it('the private key NEVER appears in the passport, the signer.publicKey, or JSON.stringify of either', () => {
    const seed = generatePassportKeypair()
    const signer = loadOrCreatePassportSigner({ AKIS_PASSPORT_PRIVATE_KEY: seed.privateKey })
    const passport = signPassport({ sessionId: 's1', testsRun: 1, codeDigest: 'c', evidenceDigest: 'e' }, signer)
    const priv = seed.privateKey
    // The passport (the wire artifact) must never carry the private key.
    expect(JSON.stringify(passport)).not.toContain(priv)
    expect(passport.publicKey).not.toContain(priv)
    // The signer's PUBLIC surface (what a route would return) must never carry the private key.
    const publicView = { publicKey: signer.publicKey, dev: signer.dev }
    expect(JSON.stringify(publicView)).not.toContain(priv)
  })
})
