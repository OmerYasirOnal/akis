import { describe, it, expect } from 'vitest'
import { mintVerifyToken } from '../../src/verify/VerifyToken.js'
import { MockTestRunner } from '../../src/verify/TestRunner.js'
import { mintApprovedSpec, SpecNotApprovedError } from '../../src/gates/specGate.js'
import { mintApprovedPush, pushToGitHub, NotVerifiedError } from '../../src/gates/pushGate.js'
import { initialSession } from '@akis/shared'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'

describe('Gate 1 — ApprovedSpec token', () => {
  it('cannot be minted without an approved spec', () => {
    const s = initialSession('s1', 'idea')
    expect(() => mintApprovedSpec(s)).toThrow(SpecNotApprovedError)
  })
  it('mints once the session carries an approvedSpec', () => {
    const s = { ...initialSession('s1', 'idea'), approvedSpec: { title: 't', body: 'b' } }
    const tok = mintApprovedSpec(s)
    expect(tok.spec.title).toBe('t')
  })
})

describe('Gate 3 — VerifyToken (fail-closed)', () => {
  it('mints only from a real >=1-test pass', async () => {
    const pass = await new MockTestRunner({ testsRun: 2, passed: true }).run([])
    expect(mintVerifyToken('s1', pass)).not.toBeNull()
  })
  it('returns null for 0 tests (vacuous green)', async () => {
    const zero = await new MockTestRunner({ testsRun: 0, passed: true }).run([])
    expect(mintVerifyToken('s1', zero)).toBeNull()
  })
  it('returns null for tests that ran but failed', async () => {
    const failed = await new MockTestRunner({ testsRun: 3, passed: false }).run([])
    expect(mintVerifyToken('s1', failed)).toBeNull()
  })
  it('default MockTestRunner fails closed (no auto-verify)', async () => {
    const def = await new MockTestRunner().run([])
    expect(def).toEqual({ __brand: 'TestRunResult', testsRun: 0, passed: false })
    expect(mintVerifyToken('s1', def)).toBeNull()
  })
})

describe('Gate 4 — pushGate', () => {
  it('mint throws without a VerifyToken; push works with a minted ApprovedPush', async () => {
    expect(() => mintApprovedPush('s1', null)).toThrow(NotVerifiedError)
    const verify = mintVerifyToken('s1', await new MockTestRunner({ testsRun: 1, passed: true }).run([]))
    const push = mintApprovedPush('s1', verify)
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const res = await pushToGitHub(push, gh, [{ filePath: 'a.ts', content: 'x' }])
    expect(res.ok).toBe(true)
    expect(gh.read('s1')).toHaveLength(1)
  })
  it('rejects a VerifyToken minted for a different session', async () => {
    const verifyForOther = mintVerifyToken('other', await new MockTestRunner({ testsRun: 1, passed: true }).run([]))
    expect(() => mintApprovedPush('s1', verifyForOther)).toThrow(NotVerifiedError)
  })
})

// @ts-expect-error — a bare object is not an ApprovedPush (branded); push without a minted token does not type-check.
const _illegalPush: import('../../src/gates/pushGate.js').ApprovedPush = { sessionId: 's1' }
void _illegalPush
// @ts-expect-error — a bare object is not a TestRunResult (branded); a producer cannot fabricate test evidence.
const _illegalResult: import('../../src/verify/TestRunner.js').TestRunResult = { testsRun: 1, passed: true }
void _illegalResult
