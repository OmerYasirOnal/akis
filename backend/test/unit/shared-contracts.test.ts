import { describe, it, expect } from 'vitest'
import { initialSession, isVerified, VERIFIER_ROLE } from '@akis/shared'
import { mintVerifyToken } from '../../src/verify/VerifyToken.js'
import { MockTestRunner } from '../../src/verify/TestRunner.js'

describe('shared contracts', () => {
  it('initial session is unverified and composing', () => {
    const s = initialSession('s1', 'build a todo app')
    expect(isVerified(s)).toBe(false)
    expect(s.status).toBe('composing')
    expect(s.approval).toBeUndefined()
    expect(s.verifyToken).toBeUndefined()
  })
  it('the verifier role is trace', () => {
    expect(VERIFIER_ROLE).toBe('trace')
  })
  it('isVerified requires a token whose sessionId matches', async () => {
    const s = initialSession('s1', 'x')
    const tokenS1 = mintVerifyToken('s1', await new MockTestRunner({ testsRun: 1, passed: true }).run([]))!
    const tokenOther = mintVerifyToken('other', await new MockTestRunner({ testsRun: 1, passed: true }).run([]))!
    expect(isVerified({ ...s, verifyToken: tokenS1 })).toBe(true)
    expect(isVerified({ ...s, verifyToken: tokenOther })).toBe(false)
  })
})

// A VerifyToken cannot be fabricated as a literal — the brand symbol is private.
// @ts-expect-error — full literal (even with fields) is not assignable to the nominal-branded VerifyToken
const _forgedVerify: import('@akis/shared').VerifyToken = { sessionId: 's1', testsRun: 1, codeDigest: 'd' }
void _forgedVerify
// @ts-expect-error — and the old fake-brand trick no longer compiles either
const _forgedVerify2: import('@akis/shared').VerifyToken = { __brand: 'VerifyToken', sessionId: 's1', testsRun: 1, codeDigest: 'd' }
void _forgedVerify2
