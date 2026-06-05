import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSmoothText } from './useSmoothText.js'

/**
 * The hook drives reveal via requestAnimationFrame. Under fake timers, rAF is backed by a
 * timer, so `vi.runOnlyPendingTimers()` (inside act) processes ONE scheduled frame. We drive
 * the animation frame-by-frame to assert the exact ceil(backlog/12) cadence.
 */
function tickFrame(): void {
  act(() => { vi.runOnlyPendingTimers() })
}

/** Install a matchMedia that reports the given reduced-motion preference (full API shape). */
function mockReducedMotion(reduce: boolean): void {
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

describe('useSmoothText', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Default: motion is ALLOWED (matchMedia present, prefers-reduced-motion: no).
    mockReducedMotion(false)
  })
  afterEach(() => {
    vi.useRealTimers()
    // Drop the matchMedia stub so it can't leak into other suites.
    delete (window as { matchMedia?: unknown }).matchMedia
  })

  it('reveals ceil(backlog/12) chars per frame (min 1), catching up to the target', () => {
    const text = 'Hello World' // 11 chars
    const { result } = renderHook(() => useSmoothText(text))
    // Effect kicks the first rAF synchronously-scheduled; before any frame ticks, nothing shown.
    expect(result.current).toBe('')
    tickFrame() // backlog 11 → ceil(11/12)=1 → "H"
    expect(result.current).toBe('H')
    tickFrame() // backlog 10 → 1 → "He"
    expect(result.current).toBe('He')
    // Drain the rest; it stays at 1/frame for this small backlog and ends EXACTLY at the target.
    for (let i = 0; i < 9; i++) tickFrame()
    expect(result.current).toBe('Hello World')
  })

  it('catches up fast on a big burst: ceil(100/12)=9 chars on the first frame', () => {
    const text = 'x'.repeat(100)
    const { result } = renderHook(() => useSmoothText(text))
    tickFrame() // backlog 100 → ceil(100/12)=9
    expect(result.current).toHaveLength(9)
    tickFrame() // backlog 91 → ceil(91/12)=8 → 17
    expect(result.current).toHaveLength(17)
  })

  it('keeps catching up as the target GROWS across re-renders (deltas append)', () => {
    const { result, rerender } = renderHook(({ s }) => useSmoothText(s), { initialProps: { s: 'abc' } })
    tickFrame()
    expect(result.current).toBe('a')
    // A delta appends: backlog jumps, the effect re-runs and resumes the reveal toward the new end.
    rerender({ s: 'abcdefghij' }) // 10 chars now, 1 shown → backlog 9
    tickFrame() // ceil(9/12)=1 → 2 shown
    expect(result.current).toBe('ab')
    for (let i = 0; i < 8; i++) tickFrame()
    expect(result.current).toBe('abcdefghij')
  })

  it('returns the empty string and schedules no frame for empty target', () => {
    const { result } = renderHook(() => useSmoothText(''))
    expect(result.current).toBe('')
    expect(vi.getTimerCount()).toBe(0) // nothing buffered → no rAF scheduled
  })

  it('reveals a single character after one frame', () => {
    const { result } = renderHook(() => useSmoothText('a'))
    expect(result.current).toBe('')
    tickFrame()
    expect(result.current).toBe('a')
    expect(vi.getTimerCount()).toBe(0) // caught up → loop stopped, no pending frame
  })

  it('clamps when the target SHRINKS below the revealed index (no slice past the end)', () => {
    const { result, rerender } = renderHook(({ s }) => useSmoothText(s), { initialProps: { s: 'Hello' } })
    for (let i = 0; i < 5; i++) tickFrame()
    expect(result.current).toBe('Hello')
    // Replace with a shorter string: the cursor must clamp, not slice past the new end.
    rerender({ s: 'Hi' })
    expect(result.current).toBe('Hi')
  })

  it('cancels the rAF on unmount (no post-unmount update / stale closure)', () => {
    const { result, unmount } = renderHook(() => useSmoothText('a much longer streaming reply'))
    tickFrame() // start revealing
    expect(result.current.length).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBeGreaterThan(0) // a frame is queued
    unmount()
    expect(vi.getTimerCount()).toBe(0) // cleanup cancelled the pending frame
    // Flushing any stragglers must not throw (no update on an unmounted component).
    expect(() => act(() => vi.runOnlyPendingTimers())).not.toThrow()
  })

  it('restarts the reveal from the beginning on remount (fresh cursor)', () => {
    const first = renderHook(() => useSmoothText('Hello'))
    for (let i = 0; i < 5; i++) tickFrame()
    expect(first.result.current).toBe('Hello')
    first.unmount()
    const second = renderHook(() => useSmoothText('Hello'))
    expect(second.result.current).toBe('') // a fresh instance starts at 0
    second.unmount()
  })

  it('respects prefers-reduced-motion: reduce — sets the full text immediately, no animation', () => {
    mockReducedMotion(true)
    const { result } = renderHook(() => useSmoothText('Instant full reply, no delay'))
    // No frame ticked, yet the full text is already shown.
    expect(result.current).toBe('Instant full reply, no delay')
    expect(vi.getTimerCount()).toBe(0) // reduced motion schedules no rAF at all
  })

  it('fails OPEN to animation when matchMedia is unavailable (older browsers / test env)', () => {
    delete (window as { matchMedia?: unknown }).matchMedia
    const { result } = renderHook(() => useSmoothText('animated'))
    // matchMedia missing → assume motion allowed → animate (not an instant full set).
    expect(result.current).toBe('')
    tickFrame()
    expect(result.current).toBe('a')
  })

  it('fails OPEN to animation when matchMedia THROWS', () => {
    window.matchMedia = vi.fn(() => { throw new Error('boom') }) as unknown as typeof window.matchMedia
    const { result } = renderHook(() => useSmoothText('animated'))
    expect(result.current).toBe('') // detection threw → animate, not freeze
    tickFrame()
    expect(result.current).toBe('a')
  })
})
