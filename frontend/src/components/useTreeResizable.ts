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
export const TREE_MIN_PX = 192        // 12rem — the tree never collapses below a readable width
export const TREE_MAX_FRACTION = 0.5  // the tree never eats more than half (the editor keeps its half)
export const TREE_RATIO_DEFAULT = 0.26 // ~matches the old fixed grid-cols-[…26%…] starting width
// A fraction floor used BEFORE the container is measured (or in jsdom where ResizeObserver reports a
// 0-width box): without a px basis we still must keep the tree from collapsing to nothing, so we floor
// to a sane fraction (~12rem at a typical ~1.6k container). Once measured, the px floor takes over.
const TREE_MIN_FRACTION = 0.12
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
 *  still can't collapse to nothing; once measured, the precise px floor takes over. */
export function clampTreeRatio(ratio: number, containerWidth: number): number {
  const minR = containerWidth ? TREE_MIN_PX / containerWidth : TREE_MIN_FRACTION
  // If the container is so narrow the min would exceed the cap, the min wins (tree stays readable).
  return Math.min(Math.max(ratio, minR), Math.max(minR, TREE_MAX_FRACTION))
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
