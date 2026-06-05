import { describe, it, expect } from 'vitest'
import { signConnectState, verifyConnectState, signState, verifyState } from '../../src/auth/oauth.js'

const SECRET = 'connect-state-secret'

describe('connect-state (HMAC-signed userId + repo binding)', () => {
  it('round-trips the userId and repo', () => {
    const state = signConnectState('user-42', 'ada/app', SECRET)
    expect(verifyConnectState(state, SECRET)).toEqual({ userId: 'user-42', repo: 'ada/app' })
  })

  it('rejects a forged signature', () => {
    expect(verifyConnectState('forged.sig', SECRET)).toBeUndefined()
    const state = signConnectState('user-42', 'ada/app', SECRET)
    // Same body, wrong secret → MAC mismatch.
    expect(verifyConnectState(state, 'a-different-secret')).toBeUndefined()
  })

  it('rejects an expired state', () => {
    const past = Math.floor(Date.now() / 1000) - 10
    const state = signConnectState('user-42', 'ada/app', SECRET, 1, past) // exp = past+1, already gone
    expect(verifyConnectState(state, SECRET)).toBeUndefined()
  })

  it('rejects a tampered userId (the MAC covers the body)', () => {
    const state = signConnectState('user-42', 'ada/app', SECRET)
    const [body, sig] = state.split('.') as [string, string]
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
    o.u = 'attacker'
    const tamperedBody = Buffer.from(JSON.stringify(o)).toString('base64url')
    // Re-pair the ORIGINAL sig with the mutated body → MAC fails.
    expect(verifyConnectState(`${tamperedBody}.${sig}`, SECRET)).toBeUndefined()
  })

  it('rejects a repo-swap (the repo is inside the MAC\'d body)', () => {
    const state = signConnectState('user-42', 'ada/app', SECRET)
    const [body, sig] = state.split('.') as [string, string]
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
    o.r = 'attacker/evil'
    const tamperedBody = Buffer.from(JSON.stringify(o)).toString('base64url')
    expect(verifyConnectState(`${tamperedBody}.${sig}`, SECRET)).toBeUndefined()
  })

  it('rejects a malformed state', () => {
    expect(verifyConnectState('nodot', SECRET)).toBeUndefined()
    expect(verifyConnectState('a.b.c', SECRET)).toBeUndefined()
  })
})

describe('login state stays untouched (byte-identical login path)', () => {
  it('signState/verifyState still round-trip and are independent of connect-state', () => {
    const s = signState('github', SECRET)
    expect(verifyState(s, SECRET)).toBe('github')
    // A connect-state must NOT verify as a login state and vice-versa.
    expect(verifyState(signConnectState('u', 'ada/app', SECRET), SECRET)).toBeUndefined()
  })
})
