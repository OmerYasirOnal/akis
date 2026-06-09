/** Bottom-sheet SNAP model for the mobile (<lg) preview sheet. The mobile preview is a draggable
 *  bottom-sheet with three snap points — peek (just the header + tabs), half, and full — so a phone
 *  user can pull the running app up to inspect it ("mobilde de genişletilebilmeli") without it ever
 *  taking a side-by-side split (which only exists at lg+). Kept as a tiny pure module (like
 *  useResizable's loadDrawer) so the snap math + persistence are unit-testable without a DOM. */

export type SheetSnap = 'peek' | 'half' | 'full'

/** Ordered LOW→HIGH so a drag can step to the adjacent snap by index (peek < half < full). */
export const SNAP_ORDER: readonly SheetSnap[] = ['peek', 'half', 'full'] as const

const KEY = 'akis_preview_sheet_snap'
const DEFAULT_SNAP: SheetSnap = 'half'

/** Each snap's height as a CSS length. peek is a fixed ~header+tabs band; half/full are viewport-
 *  relative so the sheet scales with the device. `dvh` (dynamic viewport) so the mobile browser's
 *  collapsing URL bar doesn't clip the sheet (svh/lvh churn); falls back fine where unsupported. */
export const SNAP_HEIGHT: Record<SheetSnap, string> = {
  peek: '120px',
  half: '55dvh',
  full: '92dvh',
}

/** A coarse pixel height per snap — used ONLY by the drag math to pick the nearest snap from a live
 *  drag height (the real rendered height is the CSS `SNAP_HEIGHT` above). viewportH lets the
 *  viewport-relative snaps resolve to px for the comparison; peek stays its fixed band. */
export function snapHeightPx(snap: SheetSnap, viewportH: number): number {
  if (snap === 'peek') return 120
  if (snap === 'half') return viewportH * 0.55
  return viewportH * 0.92
}

/** Load the persisted snap (defaults to 'half'); tolerant of corrupt/missing storage. */
export function loadSnap(): SheetSnap {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'peek' || v === 'half' || v === 'full' ? v : DEFAULT_SNAP
  } catch { return DEFAULT_SNAP }
}

/** Persist the snap (best-effort; storage may be unavailable/full). */
export function saveSnap(snap: SheetSnap): void {
  try { localStorage.setItem(KEY, snap) } catch { /* ignore */ }
}

/** The snap one step UP (bigger) from the given one, clamped at 'full'. */
export function snapUp(snap: SheetSnap): SheetSnap {
  const i = SNAP_ORDER.indexOf(snap)
  return SNAP_ORDER[Math.min(i + 1, SNAP_ORDER.length - 1)]!
}

/** The snap one step DOWN (smaller) from the given one, clamped at 'peek'. */
export function snapDown(snap: SheetSnap): SheetSnap {
  const i = SNAP_ORDER.indexOf(snap)
  return SNAP_ORDER[Math.max(i - 1, 0)]!
}

/** Map a LIVE drag height (px, measured from the sheet's bottom edge up to the dragged top) to the
 *  NEAREST snap. Used on pointer release: we pick the snap whose px height is closest to where the
 *  user let go, so a drag settles to a real snap rather than an arbitrary in-between height. */
export function nearestSnap(heightPx: number, viewportH: number): SheetSnap {
  let best: SheetSnap = SNAP_ORDER[0]!
  let bestDelta = Infinity
  for (const s of SNAP_ORDER) {
    const delta = Math.abs(snapHeightPx(s, viewportH) - heightPx)
    if (delta < bestDelta) { bestDelta = delta; best = s }
  }
  return best
}
