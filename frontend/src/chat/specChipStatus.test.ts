import { describe, it, expect } from 'vitest'
import { specChipStatus } from './specChipStatus.js'

describe('specChipStatus — backend status → coarse chip bucket (P1-4)', () => {
  it('buckets a finished run as "done"', () => {
    expect(specChipStatus('done')).toBe('done')
  })
  it('buckets a failed / cancelled / retryable-park run as "parked"', () => {
    expect(specChipStatus('failed')).toBe('parked')
    expect(specChipStatus('cancelled')).toBe('parked')
    expect(specChipStatus('verify_failed')).toBe('parked')
    expect(specChipStatus('push_failed')).toBe('parked')
  })
  it('buckets an in-flight run (composing / building / awaiting a gate) as "building"', () => {
    expect(specChipStatus('composing')).toBe('building')
    expect(specChipStatus('building')).toBe('building')
    expect(specChipStatus('awaiting_spec_approval')).toBe('building')
    expect(specChipStatus('awaiting_critic_resolution')).toBe('building')
    expect(specChipStatus('awaiting_push_confirm')).toBe('building')
  })
  it('defaults an unknown/undefined status to "building" (legacy in-flight copy, never a false terminal)', () => {
    expect(specChipStatus(undefined)).toBe('building')
    expect(specChipStatus('something-new')).toBe('building')
  })
})
