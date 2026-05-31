import { describe, it, expect } from 'vitest'
import { deriveVerified } from '../../src/gates/verifiedReducer.js'
import { mintApprovedPush, pushToGitHub, NotVerifiedError } from '../../src/gates/pushGate.js'
import { initialSession } from '@akis/shared'
import type { AkisEvent } from '@akis/shared'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'

const verify = (over: Partial<AkisEvent>): AkisEvent =>
  ({ kind: 'verify', testsRun: 1, passed: true, agent: 'trace', laneId: 'main', sessionId: 's1', ts: 1, ...over } as AkisEvent)

describe('Gate 3 — verifiedReducer', () => {
  it('verified only when a verifier verify event ran >=1 test and passed', () => {
    expect(deriveVerified([verify({ testsRun: 1, passed: true })])).toBe(true)
    expect(deriveVerified([verify({ testsRun: 0, passed: true })])).toBe(false)   // vacuous green
    expect(deriveVerified([verify({ testsRun: 3, passed: false })])).toBe(false)
    expect(deriveVerified([verify({ agent: 'proto' })])).toBe(false)              // not the verifier
    expect(deriveVerified([])).toBe(false)
  })
})

describe('Gate 4 — pushGate', () => {
  it('mint throws unless verified, then push requires the token', async () => {
    const unverified = initialSession('s1', 'idea')
    expect(() => mintApprovedPush(unverified)).toThrow(NotVerifiedError)

    const verified = { ...unverified, verified: true }
    const token = mintApprovedPush(verified)
    const gh = new MockGitHubAdapter(); await gh.createRepo('s1')
    const res = await pushToGitHub(token, gh, [{ filePath: 'a.ts', content: 'x' }])
    expect(res.ok).toBe(true)
    expect(gh.read('s1')).toHaveLength(1)
  })
})

// @ts-expect-error — a bare object is not an ApprovedPush (branded); push without a minted token does not type-check.
const _illegal: import('../../src/gates/pushGate.js').ApprovedPush = { sessionId: 's1' }
void _illegal
