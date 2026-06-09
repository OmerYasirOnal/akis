import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSnap, saveSnap, snapUp, snapDown, nearestSnap, snapHeightPx, SNAP_ORDER, SNAP_HEIGHT,
} from './bottomSheetSnap.js'

describe('bottomSheetSnap — snap model', () => {
  beforeEach(() => { localStorage.clear() })

  it('the snap order is peek < half < full (low → high)', () => {
    expect([...SNAP_ORDER]).toEqual(['peek', 'half', 'full'])
  })

  it('every snap has a CSS height (peek fixed, half/full viewport-relative dvh)', () => {
    expect(SNAP_HEIGHT.peek).toBe('120px')
    expect(SNAP_HEIGHT.half).toContain('dvh')
    expect(SNAP_HEIGHT.full).toContain('dvh')
  })

  it('snapUp steps up and clamps at full; snapDown steps down and clamps at peek', () => {
    expect(snapUp('peek')).toBe('half')
    expect(snapUp('half')).toBe('full')
    expect(snapUp('full')).toBe('full') // clamped
    expect(snapDown('full')).toBe('half')
    expect(snapDown('half')).toBe('peek')
    expect(snapDown('peek')).toBe('peek') // clamped
  })

  it('snapHeightPx resolves viewport-relative snaps for an 800px viewport', () => {
    expect(snapHeightPx('peek', 800)).toBe(120)
    expect(snapHeightPx('half', 800)).toBe(800 * 0.55)
    expect(snapHeightPx('full', 800)).toBe(800 * 0.92)
  })

  it('nearestSnap picks the closest snap to a live drag height', () => {
    const vh = 800 // peek=120, half=440, full=736
    expect(nearestSnap(130, vh)).toBe('peek')   // near 120
    expect(nearestSnap(420, vh)).toBe('half')   // near 440
    expect(nearestSnap(720, vh)).toBe('full')   // near 736
    expect(nearestSnap(300, vh)).toBe('half')   // 300 is closer to 440 than to 120
  })

  it('loadSnap defaults to half and round-trips a persisted snap', () => {
    expect(loadSnap()).toBe('half') // default
    saveSnap('full')
    expect(loadSnap()).toBe('full')
    saveSnap('peek')
    expect(loadSnap()).toBe('peek')
  })

  it('loadSnap tolerates a corrupt persisted value (falls back to half)', () => {
    localStorage.setItem('akis_preview_sheet_snap', 'garbage')
    expect(loadSnap()).toBe('half')
  })
})
