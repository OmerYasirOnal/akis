import { renderHook, act } from '@testing-library/react'
import { useResizable, clampRatio, MIN_PX, loadDrawer, RATIO_DEFAULT } from './useResizable.js'

test('clampRatio respects min px floor and max fraction', () => {
  expect(clampRatio(0.01, 2000)).toBeCloseTo(MIN_PX / 2000) // floored to 30rem(480px)/2000
  expect(clampRatio(0.99, 2000)).toBeLessThanOrEqual(0.6)    // max 60%
})
test('keyboard widen/narrow steps 5% and clamps', () => {
  const { result } = renderHook(() => useResizable({ containerWidth: 2000 }))
  act(() => result.current.openDrawer())
  const start = result.current.ratio
  act(() => result.current.onKeyDown({ key: 'ArrowLeft', preventDefault(){} } as any))
  expect(result.current.ratio).toBeCloseTo(clampRatio(start + 0.05, 2000))
})
test('persists ratio+open and reloads', () => {
  localStorage.clear()
  const { result, unmount } = renderHook(() => useResizable({ containerWidth: 1600 }))
  act(() => { result.current.openDrawer(); result.current.commitRatio(0.5) })
  unmount()
  expect(loadDrawer().open).toBe(true)
  expect(loadDrawer().ratio).toBeCloseTo(0.5)
})
test('Enter toggles collapse and restores last width', () => {
  const { result } = renderHook(() => useResizable({ containerWidth: 1600 }))
  act(() => { result.current.openDrawer(); result.current.commitRatio(0.5) })
  act(() => result.current.onKeyDown({ key: 'Enter', preventDefault(){} } as any))
  expect(result.current.open).toBe(false)
  act(() => result.current.onKeyDown({ key: 'Enter', preventDefault(){} } as any))
  expect(result.current.open).toBe(true); expect(result.current.ratio).toBeCloseTo(0.5)
})
