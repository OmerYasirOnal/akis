import { renderHook, act } from '@testing-library/react'
import { useTreeResizable, clampTreeRatio, TREE_MIN_PX, TREE_MAX_FRACTION, TREE_RATIO_DEFAULT, loadTreeRatio, TREE_KEY } from './useTreeResizable.js'

/**
 * useTreeResizable is the Code-tab file-tree splitter twin of the drawer's useResizable: the SAME
 * proven pointer-capture + rAF + persisted-ratio + keyboard idiom, but with the tree's own clamp
 * (min ~12rem, max 50%), its own localStorage key, and NO open/close (the tree is always shown).
 */

beforeEach(() => { localStorage.clear() })

test('clampTreeRatio respects the 12rem px floor and the 50% cap', () => {
  // A vanishingly small ratio is floored to TREE_MIN_PX / container.
  expect(clampTreeRatio(0.01, 1000)).toBeCloseTo(TREE_MIN_PX / 1000)
  // A huge ratio is capped at TREE_MAX_FRACTION (0.5).
  expect(clampTreeRatio(0.99, 1000)).toBeLessThanOrEqual(TREE_MAX_FRACTION)
  expect(clampTreeRatio(0.99, 1000)).toBeCloseTo(TREE_MAX_FRACTION)
})

test('clampTreeRatio falls back to a FRACTION floor before a width is measured (never collapses)', () => {
  // No px basis (containerWidth 0) → a sane in-range ratio passes through unchanged …
  expect(clampTreeRatio(0.42, 0)).toBeCloseTo(0.42)
  // … but a tiny ratio is still floored (the tree can't vanish on the first, unmeasured frame) …
  expect(clampTreeRatio(0.0, 0)).toBeGreaterThan(0)
  // … and the 50% cap still holds without a measured width.
  expect(clampTreeRatio(0.99, 0)).toBeCloseTo(TREE_MAX_FRACTION)
})

test('keyboard Arrow/Home/End steps and clamps the ratio', () => {
  const { result } = renderHook(() => useTreeResizable({ containerWidth: 1000 }))
  const start = result.current.ratio
  // ArrowRight widens the tree (the tree is on the LEFT, so wider = bigger ratio).
  act(() => result.current.onKeyDown({ key: 'ArrowRight', preventDefault() {} }))
  expect(result.current.ratio).toBeCloseTo(clampTreeRatio(start + 0.05, 1000))
  // ArrowLeft narrows it back.
  act(() => result.current.onKeyDown({ key: 'ArrowLeft', preventDefault() {} }))
  expect(result.current.ratio).toBeCloseTo(clampTreeRatio(start, 1000))
  // Home snaps to the min, End to the max — both clamped.
  act(() => result.current.onKeyDown({ key: 'Home', preventDefault() {} }))
  expect(result.current.ratio).toBeCloseTo(clampTreeRatio(0, 1000))
  act(() => result.current.onKeyDown({ key: 'End', preventDefault() {} }))
  expect(result.current.ratio).toBeCloseTo(clampTreeRatio(1, 1000))
})

test('persists the ratio under its OWN key and reloads it', () => {
  const { result, unmount } = renderHook(() => useTreeResizable({ containerWidth: 1200 }))
  act(() => result.current.commitRatio(0.4))
  // Persisted under the tree's dedicated key — never the drawer's.
  expect(localStorage.getItem(TREE_KEY)).toBeTruthy()
  unmount()
  expect(loadTreeRatio()).toBeCloseTo(0.4)
})

test('commitRatio clamps below the min so the tree never collapses', () => {
  const { result } = renderHook(() => useTreeResizable({ containerWidth: 1000 }))
  act(() => result.current.commitRatio(0.0)) // try to collapse the tree to nothing
  expect(result.current.ratio).toBeCloseTo(TREE_MIN_PX / 1000)
  expect(result.current.ratio).toBeGreaterThan(0)
})

test('the default ratio round-trips through loadTreeRatio when storage is empty', () => {
  expect(loadTreeRatio()).toBeCloseTo(TREE_RATIO_DEFAULT)
})
