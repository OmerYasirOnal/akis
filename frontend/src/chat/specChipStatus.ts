import type { SessionStatus } from '@akis/shared'

/** The COARSE bucket the collapsed spec chip reads from — kept minimal on purpose (P1-4):
 *  the chip is a glanceable secondary indicator, not a full lifecycle.
 *   - building → the run is live/in-flight (composing, building, awaiting a gate) — "inşa ediliyor".
 *   - done     → the run finished successfully ('done') — "tamamlandı".
 *   - parked   → the run ended UNfinished and the chip must NOT keep claiming "building": a hard
 *                fail, a user cancel, or a retryable park (verify_failed / push_failed). */
export type SpecChipStatus = 'building' | 'done' | 'parked'

/** Map a backend `SessionStatus` (or an unknown/absent value) to the coarse chip bucket. Total +
 *  pure: an undefined or unrecognized status defaults to 'building' (the legacy "inşa ediliyor"
 *  copy), so a started-but-status-unknown spec never regresses to a misleading terminal label. */
export function specChipStatus(status: SessionStatus | string | undefined): SpecChipStatus {
  switch (status) {
    case 'done':
      return 'done'
    // A hard fail, a user cancel, or a retryable park — all are "no longer building". They bucket
    // together as `parked` because the chip is intentionally coarse; the run block + recovery cards
    // carry the precise outcome and any retry affordance.
    case 'failed':
    case 'cancelled':
    case 'verify_failed':
    case 'push_failed':
      return 'parked'
    // composing / awaiting_spec_approval / building / awaiting_critic_resolution /
    // awaiting_push_confirm / unknown / undefined → still in flight.
    default:
      return 'building'
  }
}
