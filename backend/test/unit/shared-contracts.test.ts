import { describe, it, expect } from 'vitest'
import { initialSession, isVerified, VERIFIER_ROLE } from '@akis/shared'

describe('shared contracts', () => {
  it('initial session is unverified and composing', () => {
    const s = initialSession('s1', 'build a todo app')
    expect(isVerified(s)).toBe(false)
    expect(s.status).toBe('composing')
    expect(s.approvedSpec).toBeUndefined()
    expect(s.verifyToken).toBeUndefined()
  })
  it('the verifier role is trace', () => {
    expect(VERIFIER_ROLE).toBe('trace')
  })
  it('isVerified requires a token whose sessionId matches', () => {
    const s = initialSession('s1', 'x')
    expect(isVerified({ ...s, verifyToken: { __brand: 'VerifyToken', sessionId: 's1', testsRun: 1, codeDigest: 'd' } })).toBe(true)
    expect(isVerified({ ...s, verifyToken: { __brand: 'VerifyToken', sessionId: 'other', testsRun: 1, codeDigest: 'd' } })).toBe(false)
  })
})
