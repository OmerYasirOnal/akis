import { useEffect, useRef, useState } from 'react'

/**
 * Smoothly reveal a growing target string instead of letting raw SSE delta chunks jump
 * in. The hook takes the FULL accumulated text (the source of truth — deltas append to it)
 * and returns an animated SLICE of it that catches up to the target at a controlled rate:
 *
 *   reveal ceil(backlog / 12) characters per requestAnimationFrame frame (min 1)
 *
 * so a big burst (a model that bunches tokens behind latency) drains fast but never
 * teleports, while a steady one-char-per-frame stream is effectively unchanged. Frames run
 * at the display's native refresh rate, so the cost is bounded by the browser's rAF cadence.
 *
 * Display only: the caller keeps using the FULL text for everything that matters (spec/
 * suggestion extraction); this hook never sees nor alters that — it only governs how fast
 * the already-extracted, already-clean text is REVEALED. Completion is handled entirely by
 * the caller: in AkisChat, when the stream ends the streaming placeholder is dropped and a
 * fresh non-streaming message is added, so this hook is only ever mounted for the actively
 * streaming bubble and naturally stops when that bubble unmounts (no isComplete flag needed).
 *
 * Accessibility: when `prefers-reduced-motion: reduce` is set, animation is skipped and the
 * text is mirrored directly (no delay) — motion-sensitive users see no artificial reveal.
 * If matchMedia is unavailable (older browsers, some test envs) we FAIL OPEN to animation.
 *
 * @param targetText the full accumulated text to reveal
 * @returns the displayed slice (== targetText once caught up, or immediately if reduced-motion)
 */
export function useSmoothText(targetText: string): string {
  // Detect prefers-reduced-motion ONCE, defensively. A throw or a missing matchMedia must
  // not break the chat — fail open (animate) rather than fail closed (freeze the reveal).
  const reduceMotion = useRef<boolean | undefined>(undefined)
  if (reduceMotion.current === undefined) {
    try {
      reduceMotion.current = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false
    } catch {
      reduceMotion.current = false
    }
  }

  // How many characters of `targetText` are currently revealed. A ref (not state) so each
  // rAF frame reads/writes the CURRENT count without a stale closure; we bump React state
  // separately to trigger a re-render with the new slice.
  const shownRef = useRef(0)
  const [, forceRender] = useState(0)

  useEffect(() => {
    // Reduced motion: reveal everything immediately, no animation, no rAF scheduled.
    if (reduceMotion.current) {
      shownRef.current = targetText.length
      forceRender(n => n + 1)
      return
    }

    // Defensive: if the target SHRANK (e.g. a reset/replace), never show a slice longer than
    // it — clamp the cursor back so we don't slice past the end (which would also stall).
    if (shownRef.current > targetText.length) {
      shownRef.current = targetText.length
      forceRender(n => n + 1)
    }

    // Nothing buffered to reveal → don't schedule a frame at all (idle, no churn).
    if (shownRef.current >= targetText.length) return

    let handle: number | undefined
    const frame = (): void => {
      const backlog = targetText.length - shownRef.current
      if (backlog <= 0) return // caught up — stop the loop (a new effect run resumes it)
      // Catch up proportionally: big bursts drain ~12x faster than a trickle, min one char
      // so we always make progress; clamp to the end so we never overshoot the target.
      shownRef.current = Math.min(targetText.length, shownRef.current + Math.max(1, Math.ceil(backlog / 12)))
      forceRender(n => n + 1)
      if (shownRef.current < targetText.length) handle = requestAnimationFrame(frame)
    }
    // Kick the first reveal synchronously-scheduled (not awaiting a second tick) so the
    // animation starts on the very next frame after new text arrives.
    handle = requestAnimationFrame(frame)

    // Cancel any in-flight frame on unmount / before the next effect run — this is what
    // prevents a post-unmount forceRender (stale-closure / "update on unmounted component").
    return () => { if (handle !== undefined) cancelAnimationFrame(handle) }
  }, [targetText])

  // Slice is bounded by both ends: never past the target, never negative.
  return targetText.slice(0, shownRef.current)
}
