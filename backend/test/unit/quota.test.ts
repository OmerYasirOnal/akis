import { describe, it, expect } from 'vitest'
import { resolveQuotaPolicy, checkQuota, QuotaExceededError } from '../../src/usage/quota.js'
import { UsageStore, type UsageStorePort, type UsageRecord } from '../../src/usage/UsageStore.js'

const DAY = 24 * 60 * 60 * 1000

describe('resolveQuotaPolicy', () => {
  it('unset budget ⇒ unlimited (budget 0)', () => {
    expect(resolveQuotaPolicy({}).budget).toBe(0)
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '0' }).budget).toBe(0)
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: 'not-a-number' }).budget).toBe(0)
  })
  it('a positive integer budget is parsed', () => {
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '100000' }).budget).toBe(100000)
  })
  it('TIER-AWARE (paid-tier foundation): pro reads AKIS_PRO_TOKEN_BUDGET, free reads AKIS_USER_TOKEN_BUDGET; default tier is free (byte-unchanged)', () => {
    const env = { AKIS_USER_TOKEN_BUDGET: '50000', AKIS_PRO_TOKEN_BUDGET: '5000000' }
    expect(resolveQuotaPolicy(env).budget).toBe(50000)          // default tier='free' → existing behaviour
    expect(resolveQuotaPolicy(env, 'free').budget).toBe(50000)
    expect(resolveQuotaPolicy(env, 'pro').budget).toBe(5000000) // pro → its own (higher) budget
    // pro budget unset/0 ⇒ unlimited for pro, independent of the free budget
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '50000' }, 'pro').budget).toBe(0)
  })
  it('monthly is the default period; daily/weekly map to their ms', () => {
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '1' }).periodMs).toBe(30 * DAY)
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '1', AKIS_USER_TOKEN_PERIOD: 'daily' }).periodMs).toBe(DAY)
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '1', AKIS_USER_TOKEN_PERIOD: 'weekly' }).periodMs).toBe(7 * DAY)
  })
  it('a raw <n>d / <n>h period parses', () => {
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '1', AKIS_USER_TOKEN_PERIOD: '3d' }).periodMs).toBe(3 * DAY)
    expect(resolveQuotaPolicy({ AKIS_USER_TOKEN_BUDGET: '1', AKIS_USER_TOKEN_PERIOD: '12h' }).periodMs).toBe(12 * 60 * 60 * 1000)
  })
})

describe('checkQuota', () => {
  it('unlimited (budget 0) ⇒ allowed:true with NO store read', async () => {
    let reads = 0
    const store: UsageStorePort = {
      async add() {},
      async get(ownerId): Promise<UsageRecord> { reads++; return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    const d = await checkQuota(store, { budget: 0, periodMs: DAY }, 'ada')
    expect(d.allowed).toBe(true)
    expect(d.budget).toBe(0)
    expect(d.remaining).toBe(-1) // sentinel = unlimited
    expect(reads).toBe(0)        // byte-identical default path: no store read
  })

  it('under budget ⇒ allowed:true, remaining computed, resetAt = windowStart + periodMs', async () => {
    const store = new UsageStore({ periodMs: DAY, clock: () => 1_000_000 })
    await store.add('ada', 400)
    const d = await checkQuota(store, { budget: 1000, periodMs: DAY }, 'ada', 1_000_000)
    expect(d.allowed).toBe(true)
    expect(d.usedTokens).toBe(400)
    expect(d.remaining).toBe(600)
    expect(new Date(d.resetAt).getTime()).toBe(1_000_000 + DAY)
  })

  it('at/over budget ⇒ allowed:false', async () => {
    const store = new UsageStore({ periodMs: DAY, clock: () => 1_000_000 })
    await store.add('ada', 1000)
    const at = await checkQuota(store, { budget: 1000, periodMs: DAY }, 'ada', 1_000_000)
    expect(at.allowed).toBe(false) // remaining 0 → not > 0
    await store.add('ada', 5)
    const over = await checkQuota(store, { budget: 1000, periodMs: DAY }, 'ada', 1_000_000)
    expect(over.allowed).toBe(false)
  })

  it('anonymous owner routes to the shared __anon__ bucket when budgeted', async () => {
    const store = new UsageStore({ periodMs: DAY, clock: () => 1_000_000 })
    await store.add('__anon__', 1000)
    const d = await checkQuota(store, { budget: 1000, periodMs: DAY }, undefined, 1_000_000)
    expect(d.allowed).toBe(false) // the anonymous shared bucket is exhausted
  })

  it('anonymous + unlimited ⇒ allowed with NO store read', async () => {
    let reads = 0
    const store: UsageStorePort = {
      async add() {},
      async get(ownerId): Promise<UsageRecord> { reads++; return { ownerId, usedTokens: 0, periodTokens: 0, windowStart: '' } },
      async snapshotAll() { return [] },
    }
    const d = await checkQuota(store, { budget: 0, periodMs: DAY }, undefined)
    expect(d.allowed).toBe(true)
    expect(reads).toBe(0)
  })

  it('QuotaExceededError carries resetAt and code-friendly name', () => {
    const e = new QuotaExceededError('2026-07-01T00:00:00.000Z')
    expect(e.name).toBe('QuotaExceededError')
    expect(e.resetAt).toBe('2026-07-01T00:00:00.000Z')
  })
})
