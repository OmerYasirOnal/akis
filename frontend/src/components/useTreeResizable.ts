import { useCallback, useEffect, useState } from 'react'

/**
 * The Code-tab file-tree splitter hook — the file-tree (left) ⇄ editor (right) twin of the drawer's
 * `useResizable`. It deliberately REUSES the SAME proven idiom (persisted ratio + clamp + keyboard
 * Arrow/Home/End), but the tree has different constraints than the drawer:
 *   • its OWN localStorage key (`akis_code_tree_ratio`) so it never fights the drawer's `akis_preview_drawer`;
 *   • a 12rem px floor + a 50% cap (the tree never collapses, never eats the editor's half);
 *   • NO open/close — the tree is always visible inside the Code tab, so there's no toggle here.
 * The live pointer-drag math (clientX → ratio) lives in the CONSUMER (CodeBrowser), exactly like the
 * drawer's drag math lives in ChatStudio — this hook owns only the persisted/keyboard committed ratio.
 */

export const TREE_KEY = 'akis_code_tree_ratio'
// NARROWER (owner feedback 1 — "the file-list is ÇOK GENİŞ"): the tree is a scannable INDEX, not a
// second editor, so it gets a slim default and a low floor. 10rem floor (was 12rem) keeps a readable
// width without eating the editor; the 45% cap (was 50%) gives the editor the clear majority; the 22%
// default (was 26%) opens slim and the user widens on demand. The drag range remains real on desktop.
export const TREE_MIN_PX = 160        // 10rem — the tree never collapses below a readable width
export const TREE_MAX_FRACTION = 0.45 // the tree never eats more than ~45% (the editor keeps the majority)
export const TREE_RATIO_DEFAULT = 0.22 // a slim default — the file index, not half the panel
// A fraction floor used BEFORE the container is measured (or in jsdom where ResizeObserver reports a
// 0-width box): without a px basis we still must keep the tree from collapsing to nothing, so we floor
// to a sane fraction (~10rem at a typical ~1.6k container). Once measured, the px floor takes over.
const TREE_MIN_FRACTION = 0.1
const STEP = 0.05

export function loadTreeRatio(): number {
  try {
    const raw = localStorage.getItem(TREE_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) ? n : TREE_RATIO_DEFAULT
  } catch { return TREE_RATIO_DEFAULT }
}
function save(ratio: number): void {
  try { localStorage.setItem(TREE_KEY, String(ratio)) } catch { /* ignore (private mode / quota) */ }
}

/** Clamp a tree ratio to [TREE_MIN_PX, TREE_MAX_FRACTION] for the given container width. Before a width
 *  is measured we have no px basis, so we fall back to a FRACTION floor (TREE_MIN_FRACTION) — the tree
 *  still can't collapse to nothing; once measured, the precise px floor takes over.
 *
 *  NARROW-CONTAINER RULE (mobile bottom-sheet at ≤~384px): when the 12rem px floor would exceed the 50%
 *  cap, the CAP wins — the editor always keeps at least half, so the tree can't dominate the sheet (it
 *  shrinks below 12rem instead). On a roomy desktop container the px floor is the binding constraint. */
export function clampTreeRatio(ratio: number, containerWidth: number): number {
  const rawMin = containerWidth ? TREE_MIN_PX / containerWidth : TREE_MIN_FRACTION
  // The effective min never exceeds the cap (the editor's half is sacred); on a wide container rawMin is
  // small and binds, on a narrow one the cap binds.
  const minR = Math.min(rawMin, TREE_MAX_FRACTION)
  return Math.min(Math.max(ratio, minR), TREE_MAX_FRACTION)
}

export function useTreeResizable({ containerWidth }: { containerWidth: number }) {
  const [ratio, setRatio] = useState(loadTreeRatio)

  // Re-clamp against the CURRENT container whenever it changes (a resize must not strand a stale ratio
  // that now violates the px floor / 50% cap) — mirrors useResizable's re-clamp effect.
  useEffect(() => { if (containerWidth) setRatio(r => clampTreeRatio(r, containerWidth)) }, [containerWidth])
  useEffect(() => { save(ratio) }, [ratio])

  const commitRatio = useCallback((r: number) => {
    setRatio(clampTreeRatio(r, containerWidth))
  }, [containerWidth])

  // Keyboard resize parity with the drawer splitter: Arrow steps ±5%, Home/End jump to the clamped
  // min/max. ArrowRight widens the tree (it sits on the LEFT, so wider = larger ratio).
  const onKeyDown = useCallback((e: { key: string; preventDefault(): void }) => {
    if (e.key === 'Home') { e.preventDefault(); commitRatio(0); return }
    if (e.key === 'End') { e.preventDefault(); commitRatio(1); return }
    const dir = e.key === 'ArrowRight' ? +1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!dir) return
    e.preventDefault()
    commitRatio(ratio + dir * STEP)
  }, [ratio, commitRatio])

  return { ratio, commitRatio, setRatioLive: setRatio, onKeyDown }
}
