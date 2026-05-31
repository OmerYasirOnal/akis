import type { AkisEvent } from '@akis/shared'
import { VERIFIER_ROLE } from '@akis/shared'

/**
 * Gate 3 — "verified" = a real test run.
 *
 * `verified` becomes true ONLY when a verify event, emitted by the verifier
 * role, reports that at least one test executed and passed. No agent can set
 * this directly — it is derived from the event stream. A run with 0 tests
 * (vacuous green) or a failing run never verifies.
 */
export function deriveVerified(events: AkisEvent[]): boolean {
  return events.some(
    e => e.kind === 'verify' && e.agent === VERIFIER_ROLE && e.testsRun >= 1 && e.passed === true,
  )
}
