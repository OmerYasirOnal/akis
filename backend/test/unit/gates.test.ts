import { describe, it, expect } from 'vitest'
import { mintVerifyToken } from '../../src/verify/VerifyToken.js'
import { MockTestRunner } from '../../src/verify/TestRunner.js'
import { digestFiles } from '../../src/verify/digest.js'
import { mintApprovedSpec, brandApproval, SpecNotApprovedError } from '../../src/gates/specGate.js'
import { mintApprovedPush, pushToGitHub, NotVerifiedError, CodeMismatchError } from '../../src/gates/pushGate.js'
import { initialSession, isVerified } from '@akis/shared'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'

const FILES = [{ filePath: 'a.ts', content: 'x' }]
const DIGEST = digestFiles(FILES)

describe('Gate 1 — ApprovedSpec token', () => {
  it('cannot be minted without an approved spec', () => {
    expect(() => mintApprovedSpec(initialSession('s1', 'idea'))).toThrow(SpecNotApprovedError)
  })
  it('mints once the session carries a valid approval token', () => {
    const s = { ...initialSession('s1', 'idea'), approval: brandApproval({ title: 't', body: 'b' }) }
    expect(mintApprovedSpec(s).spec.title).toBe('t')
  })
})

describe('Gate 3 — VerifyToken (fail-closed)', () => {
  it('mints only from a real >=1-test pass', async () => {
    const pass = await new MockTestRunner({ testsRun: 2, passed: true }).run(FILES)
    expect(mintVerifyToken('s1', pass)).not.toBeNull()
  })
  it('returns null for 0 tests (vacuous green)', async () => {
    const zero = await new MockTestRunner({ testsRun: 0, passed: true }).run(FILES)
    expect(mintVerifyToken('s1', zero)).toBeNull()
  })
  it('returns null for tests that ran but failed', async () => {
    const failed = await new MockTestRunner({ testsRun: 3, passed: false }).run(FILES)
    expect(mintVerifyToken('s1', failed)).toBeNull()
  })
  it('default MockTestRunner fails closed (no auto-verify)', async () => {
    const def = await new MockTestRunner().run(FILES)
    expect(def.testsRun).toBe(0)
    expect(def.passed).toBe(false)
    expect(mintVerifyToken('s1', def)).toBeNull()
  })
})

describe('Gate 4 — pushGate', () => {
  it('mint throws without a VerifyToken; push works with a minted ApprovedPush', async () => {
    const unverified = initialSession('s1', 'idea')
    expect(() => mintApprovedPush(unverified, FILES)).toThrow(NotVerifiedError)

    const token = mintVerifyToken('s1', await new MockTestRunner({ testsRun: 1, passed: true }).run(FILES))!
    const verified = { ...unverified, verifyToken: token }
    expect(isVerified(verified)).toBe(true)
    const push = mintApprovedPush(verified, FILES)
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const res = await pushToGitHub(push, gh, FILES)
    expect(res.ok).toBe(true)
    expect(gh.read('s1')).toHaveLength(1)
  })

  it('rejects pushing files that differ from the verified code (digest mismatch)', async () => {
    const token = mintVerifyToken('s1', await new MockTestRunner({ testsRun: 1, passed: true }).run(FILES))!
    const verified = { ...initialSession('s1', 'idea'), verifyToken: token }
    expect(() => mintApprovedPush(verified, [{ filePath: 'a.ts', content: 'TAMPERED' }])).toThrow(CodeMismatchError)
  })

  it('rejects a VerifyToken minted for a different session', async () => {
    const tokenForOther = mintVerifyToken('other', await new MockTestRunner({ testsRun: 1, passed: true }).run(FILES))!
    const session = { ...initialSession('s1', 'idea'), verifyToken: tokenForOther }
    expect(isVerified(session)).toBe(false)
    expect(() => mintApprovedPush(session, FILES)).toThrow(NotVerifiedError)
  })

  it('binds verification to the runner-computed digest (caller cannot substitute)', async () => {
    // The runner computes the digest from the files it actually ran; the token
    // carries THAT digest, so a token from one file set cannot authorize another.
    const ranA = await new MockTestRunner({ testsRun: 1, passed: true }).run(FILES)
    const tokenA = mintVerifyToken('s1', ranA)!
    const verified = { ...initialSession('s1', 'idea'), verifyToken: tokenA }
    expect(() => mintApprovedPush(verified, [{ filePath: 'b.ts', content: 'other' }])).toThrow(CodeMismatchError)
    expect(mintApprovedPush(verified, FILES)).toBeTruthy() // matching files OK
  })
})

describe('digest collision-resistance', () => {
  it('distinct file sets that would collide under naive concat get distinct digests', () => {
    // Naive `${path} ${content}` join collides: ['a','b c'] vs ['a b','c'].
    const setA = [{ filePath: 'a', content: 'b c' }]
    const setB = [{ filePath: 'a b', content: 'c' }]
    expect(digestFiles(setA)).not.toBe(digestFiles(setB))
  })
  it('is order-independent (sorted canonical form)', () => {
    const f1 = { filePath: 'a.ts', content: '1' }
    const f2 = { filePath: 'b.ts', content: '2' }
    expect(digestFiles([f1, f2])).toBe(digestFiles([f2, f1]))
  })
})

// ── Nominal-brand tripwires: a FULL literal WITH the fake brand string must STILL
// fail to type-check (this is what review #3 proved was broken before). ──────────
// @ts-expect-error — ApprovedPush is nominally branded; no literal can satisfy it.
const _illegalPush: import('../../src/gates/pushGate.js').ApprovedPush = { __brand: 'ApprovedPush', sessionId: 's1' }
void _illegalPush
// @ts-expect-error — TestRunResult is nominally branded; a producer cannot fabricate evidence.
const _illegalResult: import('../../src/verify/TestRunner.js').TestRunResult = { __brand: 'TestRunResult', testsRun: 1, passed: true }
void _illegalResult
// @ts-expect-error — VerifyToken is nominally branded; the store cannot fabricate verification.
const _illegalVerify: import('@akis/shared').VerifyToken = { __brand: 'VerifyToken', sessionId: 's1', testsRun: 1, codeDigest: 'd' }
void _illegalVerify
// @ts-expect-error — ApprovalToken is nominally branded; approval cannot be forged.
const _illegalApproval: import('@akis/shared').ApprovalToken = { __brand: 'ApprovalToken', spec: { title: 't', body: 'b' }, specDigest: 'd' }
void _illegalApproval
