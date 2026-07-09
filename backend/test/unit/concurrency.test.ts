import { describe, it, expect, vi } from 'vitest'
import { checkConcurrency, resolveConcurrencyPolicy, ACTIVE_RUN_STATUSES } from '../../src/usage/concurrency.js'
import type { SessionState } from '@akis/shared'

const sessions = (...statuses: string[]): SessionState[] => statuses.map((status, i) => ({ id: `s${i}`, status }) as SessionState)
const storeWith = (list: SessionState[]) => ({ listByOwner: vi.fn(async () => list) })

describe('resolveConcurrencyPolicy (env)', () => {
  it('0/unset/NaN ⇒ unlimited (the single-operator dev default, byte-unchanged)', () => {
    expect(resolveConcurrencyPolicy({}).maxActiveRuns).toBe(0)
    expect(resolveConcurrencyPolicy({ AKIS_MAX_ACTIVE_RUNS: '0' }).maxActiveRuns).toBe(0)
    expect(resolveConcurrencyPolicy({ AKIS_MAX_ACTIVE_RUNS: 'lots' }).maxActiveRuns).toBe(0)
    expect(resolveConcurrencyPolicy({ AKIS_MAX_ACTIVE_RUNS: '-3' }).maxActiveRuns).toBe(0)
  })
  it('a positive integer sets the cap (truncated)', () => {
    expect(resolveConcurrencyPolicy({ AKIS_MAX_ACTIVE_RUNS: '2' }).maxActiveRuns).toBe(2)
    expect(resolveConcurrencyPolicy({ AKIS_MAX_ACTIVE_RUNS: '2.9' }).maxActiveRuns).toBe(2)
  })
})

describe('checkConcurrency (per-user active-run cap, start-only fail-closed)', () => {
  it('limit 0 ⇒ unlimited with NO store read (dev fast-path)', async () => {
    const store = storeWith(sessions('building', 'building'))
    const d = await checkConcurrency(store, { maxActiveRuns: 0 }, 'u1')
    expect(d.allowed).toBe(true)
    expect(store.listByOwner).not.toHaveBeenCalled()
  })

  it('anonymous (no ownerId) is exempt — governed by requireAuthForBuilds + the anon token quota instead', async () => {
    const store = storeWith(sessions('building'))
    const d = await checkConcurrency(store, { maxActiveRuns: 1 }, undefined)
    expect(d.allowed).toBe(true)
    expect(store.listByOwner).not.toHaveBeenCalled()
  })

  it('counts ONLY pipeline-running statuses (composing/building) — parked/awaiting/terminal are free', async () => {
    const store = storeWith(sessions('building', 'composing', 'awaiting_spec_approval', 'awaiting_push_confirm', 'push_failed', 'verify_failed', 'done', 'cancelled', 'failed'))
    const d = await checkConcurrency(store, { maxActiveRuns: 3 }, 'u1')
    expect(d.activeRuns).toBe(2)
    expect(d.allowed).toBe(true)
  })

  it('blocks at the cap: active === limit ⇒ refused; one below ⇒ allowed', async () => {
    expect((await checkConcurrency(storeWith(sessions('building')), { maxActiveRuns: 2 }, 'u1')).allowed).toBe(true)
    const d = await checkConcurrency(storeWith(sessions('building', 'composing')), { maxActiveRuns: 2 }, 'u1')
    expect(d.allowed).toBe(false)
    expect(d.activeRuns).toBe(2)
    expect(d.limit).toBe(2)
  })

  it('the active-status set is exactly {composing, building} (pin: nothing parked ever counts)', () => {
    expect([...ACTIVE_RUN_STATUSES].sort()).toEqual(['building', 'composing'])
  })
})
