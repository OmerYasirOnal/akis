import { describe, it, expect } from 'vitest'
import { initialSession, VERIFIER_ROLE } from '@akis/shared'

describe('shared contracts', () => {
  it('initial session is unverified and composing', () => {
    const s = initialSession('s1', 'build a todo app')
    expect(s.verified).toBe(false)
    expect(s.status).toBe('composing')
    expect(s.approvedSpec).toBeUndefined()
  })
  it('the verifier role is trace', () => {
    expect(VERIFIER_ROLE).toBe('trace')
  })
})
