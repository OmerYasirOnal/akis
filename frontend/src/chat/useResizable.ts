import { useCallback, useEffect, useRef, useState } from 'react'

const KEY = 'akis_preview_drawer'
export const MIN_PX = 480           // 30rem
export const MAX_FRACTION = 0.6
const CHAT_FLOOR_PX = 448           // 28rem — chat never narrower than this
export const RATIO_DEFAULT = 0.46
const STEP = 0.05

export interface DrawerState { ratio: number; open: boolean }
export function loadDrawer(): DrawerState {
  try { const j = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ratio: typeof j.ratio === 'number' ? j.ratio : RATIO_DEFAULT, open: !!j.open } }
  catch { return { ratio: RATIO_DEFAULT, open: false } }
}
function save(s: DrawerState) { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* ignore */ } }

/** Clamp a ratio to [MIN_PX, min(MAX_FRACTION, 1 - chatFloor)] for a given container width. */
export function clampRatio(ratio: number, containerWidth: number): number {
  if (!containerWidth) return ratio
  const minR = MIN_PX / containerWidth
  const maxR = Math.min(MAX_FRACTION, 1 - CHAT_FLOOR_PX / containerWidth)
  return Math.min(Math.max(ratio, minR), Math.max(minR, maxR))
}

export function useResizable({ containerWidth }: { containerWidth: number }) {
  const init = loadDrawer()
  const [open, setOpen] = useState(init.open)
  const [ratio, setRatio] = useState(init.ratio)
  const lastOpenRatio = useRef(init.ratio)
  const dragging = useRef(false)

  // re-clamp against the CURRENT container whenever it changes (M1)
  useEffect(() => { if (containerWidth) setRatio(r => clampRatio(r, containerWidth)) }, [containerWidth])
  useEffect(() => { save({ ratio, open }) }, [ratio, open])

  const openDrawer = useCallback(() => setOpen(true), [])
  const closeDrawer = useCallback(() => setOpen(false), [])
  const commitRatio = useCallback((r: number) => {
    const c = clampRatio(r, containerWidth); setRatio(c); if (open) lastOpenRatio.current = c
  }, [containerWidth, open])

  const onKeyDown = useCallback((e: { key: string; preventDefault(): void }) => {
    if (e.key === 'Enter') { e.preventDefault(); setOpen(o => { if (o) return false; setRatio(clampRatio(lastOpenRatio.current, containerWidth)); return true }); return }
    const dir = e.key === 'ArrowLeft' || e.key === 'End' ? +1 : e.key === 'ArrowRight' || e.key === 'Home' ? -1 : 0
    if (!dir) return; e.preventDefault(); commitRatio(ratio + dir * STEP)
  }, [ratio, containerWidth, commitRatio])

  return { open, ratio, dragging, openDrawer, closeDrawer, commitRatio, setRatioLive: setRatio, onKeyDown }
}
