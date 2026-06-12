/**
 * F8 — SINGLE SOURCE OF TRUTH for the park/terminal (cancel-immune) status set.
 *
 * The set lives in shared/src/session.ts so the BACKEND cancel-refusal guard and the FRONTEND's
 * terminal-vs-live decision read the exact same membership and can never drift. This locks the
 * membership + the type guard, and proves the orchestrator's cancel refusal stands on the SHARED
 * set (the behavioral parity is covered by orchestrator-cancel.test.ts's A4 cases; here we pin the
 * data contract so a silent membership edit can't slip past both consumers).
 */
import { describe, it, expect } from 'vitest'
import { CANCEL_IMMUNE_STATUSES, isCancelImmune, type SessionStatus } from '@akis/shared'

describe('CANCEL_IMMUNE_STATUSES (shared park/terminal set)', () => {
  it('contains exactly the terminal states PLUS the retryable parks', () => {
    expect([...CANCEL_IMMUNE_STATUSES].sort()).toEqual(
      ['cancelled', 'done', 'failed', 'push_failed', 'verify_failed'].sort(),
    )
  })

  it('the live-gate parks STAY cancellable (abandon-at-gate is a legitimate stop)', () => {
    expect(CANCEL_IMMUNE_STATUSES.has('awaiting_push_confirm' as SessionStatus)).toBe(false)
    expect(CANCEL_IMMUNE_STATUSES.has('awaiting_critic_resolution' as SessionStatus)).toBe(false)
  })

  it('isCancelImmune mirrors the set (and is false for undefined / a live status)', () => {
    expect(isCancelImmune('push_failed')).toBe(true)
    expect(isCancelImmune('verify_failed')).toBe(true)
    expect(isCancelImmune('done')).toBe(true)
    expect(isCancelImmune('building')).toBe(false)
    expect(isCancelImmune('awaiting_push_confirm')).toBe(false)
    expect(isCancelImmune(undefined)).toBe(false)
  })
})
