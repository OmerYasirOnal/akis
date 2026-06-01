import { describe, it, expect } from 'vitest'
import { digestFiles } from '../../src/verify/digest.js'
import { mintApprovedSpec, SpecNotApprovedError } from '../../src/gates/specGate.js'
import { mintApprovedPush, pushToGitHub, NotVerifiedError, CodeMismatchError } from '../../src/gates/pushGate.js'
import { initialSession, isVerified, type SpecArtifact } from '@akis/shared'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { verifyWith, approveSpec } from '../helpers/tokens.js'

const FILES = [{ filePath: 'a.ts', content: 'x' }]
const SPEC: SpecArtifact = { title: 't', body: 'b' }
/** A session whose stored spec matches the approval (Gate 1 binds approval→reviewed spec). */
const approvedSession = (id: string) => ({ ...initialSession(id, 'idea'), spec: SPEC, approval: approveSpec(SPEC) })

describe('Gate 1 — ApprovedSpec token', () => {
  it('cannot be minted without an approval token', () => {
    expect(() => mintApprovedSpec(initialSession('s1', 'idea'))).toThrow(SpecNotApprovedError)
  })
  it('mints once the session carries a valid approval bound to its spec', () => {
    expect(mintApprovedSpec(approvedSession('s1')).spec.title).toBe('t')
  })
  it('rejects an approval token for a DIFFERENT spec than the session reviewed (substitution)', () => {
    const s = { ...initialSession('s1', 'idea'), spec: SPEC, approval: approveSpec({ title: 'EVIL', body: 'malicious' }) }
    expect(() => mintApprovedSpec(s)).toThrow(SpecNotApprovedError)
  })
})

describe('Gate 3 — VerifyToken (fail-closed, via the Verifier capability)', () => {
  it('mints only from a real >=1-test pass', async () => {
    expect(await verifyWith('s1', FILES, { testsRun: 2, passed: true })).not.toBeNull()
  })
  it('returns null for 0 tests (vacuous green)', async () => {
    expect(await verifyWith('s1', FILES, { testsRun: 0, passed: true })).toBeNull()
  })
  it('returns null for tests that ran but failed', async () => {
    expect(await verifyWith('s1', FILES, { testsRun: 3, passed: false })).toBeNull()
  })
  it('default runner fails closed (no auto-verify)', async () => {
    expect(await verifyWith('s1', FILES, { testsRun: 0, passed: false })).toBeNull()
  })
})

describe('Gate 4 — pushGate', () => {
  it('mint throws without a VerifyToken; push works with a minted ApprovedPush', async () => {
    const unverified = initialSession('s1', 'idea')
    expect(() => mintApprovedPush(unverified, FILES)).toThrow(NotVerifiedError)

    const token = (await verifyWith('s1', FILES, { testsRun: 1, passed: true }))!
    const verified = { ...unverified, verifyToken: token }
    expect(isVerified(verified)).toBe(true)
    const push = mintApprovedPush(verified, FILES)
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const res = await pushToGitHub(push, gh, FILES)
    expect(res.ok).toBe(true)
    expect(gh.read('s1')).toHaveLength(1)
  })

  it('rejects pushing files that differ from the verified code (digest mismatch)', async () => {
    const token = (await verifyWith('s1', FILES, { testsRun: 1, passed: true }))!
    const verified = { ...initialSession('s1', 'idea'), verifyToken: token }
    expect(() => mintApprovedPush(verified, [{ filePath: 'a.ts', content: 'TAMPERED' }])).toThrow(CodeMismatchError)
  })

  it('rejects a VerifyToken minted for a different session', async () => {
    const tokenForOther = (await verifyWith('other', FILES, { testsRun: 1, passed: true }))!
    const session = { ...initialSession('s1', 'idea'), verifyToken: tokenForOther }
    expect(isVerified(session)).toBe(false)
    expect(() => mintApprovedPush(session, FILES)).toThrow(NotVerifiedError)
  })

  it('binds verification to the runner-computed digest (caller cannot substitute)', async () => {
    const tokenA = (await verifyWith('s1', FILES, { testsRun: 1, passed: true }))!
    const verified = { ...initialSession('s1', 'idea'), verifyToken: tokenA }
    expect(() => mintApprovedPush(verified, [{ filePath: 'b.ts', content: 'other' }])).toThrow(CodeMismatchError)
    expect(mintApprovedPush(verified, FILES)).toBeTruthy()
  })
})

describe('digest collision-resistance', () => {
  it('distinct file sets that would collide under naive concat get distinct digests', () => {
    expect(digestFiles([{ filePath: 'a', content: 'b c' }])).not.toBe(digestFiles([{ filePath: 'a b', content: 'c' }]))
  })
  it('is order-independent (sorted canonical form)', () => {
    const f1 = { filePath: 'a.ts', content: '1' }
    const f2 = { filePath: 'b.ts', content: '2' }
    expect(digestFiles([f1, f2])).toBe(digestFiles([f2, f1]))
  })
})

// ── Capability tripwires: the forging minters are NOT importable (TS2305) and the
// branded tokens are not literal-constructible. These FAIL TO COMPILE if a future
// change re-exports a minter or weakens a brand. ────────────────────────────────
// @ts-expect-error — mintVerifyToken is module-private; no bare import (capability only).
import { mintVerifyToken as _mv } from '../../src/verify/VerifyToken.js'
void (_mv as unknown)
// @ts-expect-error — the mock runner CLASS is module-private; only the factory is public.
import { MockTestRunner as _mtr } from '../../src/verify/TestRunner.js'
void (_mtr as unknown)
// @ts-expect-error — the approval brand is module-private; only the authority mints.
import { brandApproval as _ba } from '../../src/gates/specGate.js'
void (_ba as unknown)
// @ts-expect-error — VerifyToken cannot be written as a literal (nominal brand).
const _illegalVerify: import('@akis/shared').VerifyToken = { __brand: 'VerifyToken', sessionId: 's1', testsRun: 1, codeDigest: 'd' }
void _illegalVerify
// @ts-expect-error — ApprovedPush cannot be written as a literal (nominal brand).
const _illegalPush: import('../../src/gates/pushGate.js').ApprovedPush = { __brand: 'ApprovedPush', sessionId: 's1' }
void _illegalPush
