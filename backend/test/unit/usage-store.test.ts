import { describe, it, expect } from 'vitest'
import { UsageStore } from '../../src/usage/UsageStore.js'

describe('UsageStore', () => {
  it('add accumulates in+out per owner; absent/zero usage adds 0 (never fabricated)', async () => {
    const store = new UsageStore()
    await store.add('ada', 100)
    await store.add('ada', 50)
    await store.add('bo', 7)
    expect((await store.get('ada')).usedTokens).toBe(150)
    expect((await store.get('ada')).periodTokens).toBe(150)
    expect((await store.get('bo')).usedTokens).toBe(7)
    // add of 0 is a no-op-but-still-creates-the-record at 0 (so get returns a real record).
    await store.add('cy', 0)
    expect((await store.get('cy')).usedTokens).toBe(0)
  })

  it('get returns a zero record for an unknown owner', async () => {
    const store = new UsageStore()
    const r = await store.get('nobody')
    expect(r.usedTokens).toBe(0)
    expect(r.periodTokens).toBe(0)
    expect(r.ownerId).toBe('nobody')
    expect(typeof r.windowStart).toBe('string')
  })

  it('window rolls forward after periodMs: periodTokens resets, usedTokens (lifetime) persists', async () => {
    let now = 1_000_000
    const store = new UsageStore({ periodMs: 1000, clock: () => now })
    await store.add('ada', 80) // window opens at 1_000_000
    expect((await store.get('ada')).periodTokens).toBe(80)
    now += 1500 // past the 1000ms window
    const rolled = await store.get('ada')
    expect(rolled.periodTokens).toBe(0)       // the period reset
    expect(rolled.usedTokens).toBe(80)        // lifetime persists
    // A new add lands in the fresh window.
    await store.add('ada', 30)
    expect((await store.get('ada')).periodTokens).toBe(30)
    expect((await store.get('ada')).usedTokens).toBe(110)
  })

  it('negative/NaN tokens are clamped to 0 (never trust a number into accounting)', async () => {
    const store = new UsageStore()
    await store.add('ada', -50)
    await store.add('ada', Number.NaN)
    await store.add('ada', Number.POSITIVE_INFINITY)
    expect((await store.get('ada')).usedTokens).toBe(0)
    await store.add('ada', 5)
    expect((await store.get('ada')).usedTokens).toBe(5)
  })

  it('snapshot/hydrate round-trips the records (for the dev-file wrapper)', async () => {
    const store = new UsageStore()
    await store.add('ada', 10)
    await store.add('bo', 3)
    const snap = store.snapshot()
    const restored = new UsageStore()
    restored.hydrate(snap)
    expect((await restored.get('ada')).usedTokens).toBe(10)
    expect((await restored.get('bo')).usedTokens).toBe(3)
  })

  it('periodMs 0/undefined never rolls (a single open window)', async () => {
    let now = 0
    const store = new UsageStore({ clock: () => now }) // no periodMs
    await store.add('ada', 40)
    now += 10_000_000
    expect((await store.get('ada')).periodTokens).toBe(40) // never reset
  })
})
