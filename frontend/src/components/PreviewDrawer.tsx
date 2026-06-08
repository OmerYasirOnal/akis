import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext.js'

/** Fill {n}/{base} placeholders in a string (the catalog carries the template). Same local helper idiom
 *  as AgentWriteProposals.tsx — i18n keeps templates; the FE interpolates at render. */
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)

const RATIO_MIN_PCT = 25 // aria-valuemin — chat keeps the majority of the width at the floor
const RATIO_MAX_PCT = 60 // aria-valuemax — mirrors useResizable MAX_FRACTION

export interface PreviewDrawerProps {
  /** Whether the drawer is slid in (push-split) or collapsed to the edge-tab. View-state only. */
  open: boolean
  /** Current width ratio (0..1 of the container) — drives the separator's aria-valuenow/text. */
  ratio: number
  /** Keyboard splitter handler from useResizable — Arrow/Home/End/Enter widen/narrow/toggle. */
  onKeyDown: (e: { key: string; preventDefault(): void }) => void
  /** Live pointer-drag tick: the parent owns container geometry, so it maps clientX → `--preview-w`.
   *  Called at most once per animation frame while dragging the separator. */
  onPointerWidth: (clientX: number) => void
  /** Drag commit on pointerup — the parent maps the final clientX → ratio and persists it. */
  commitRatio: (clientX: number) => void
  /** Open the drawer (the collapsed edge-tab calls this). */
  onOpen: () => void
  /** Close the drawer (the ✕ calls this). */
  onClose: () => void
  /** Whether the active build is VERIFIED — drives the dot on the collapsed edge-tab (L3) AND the mobile FAB. */
  verified?: boolean
  /** Mobile-overlay (M1) guard: on `<lg` the parent passes false so a persisted `open:true` does NOT
   *  auto-show the full-screen overlay on load — it requires an explicit FAB tap. Defaults to false so the
   *  overlay is closed-on-load by default; the desktop push-split is unaffected (it reads `open` directly). */
  allowAutoOpen?: boolean
  /** Region A: the gate-adjacent card stack (Trust/Publish/Proposals/ExternalWrite). */
  cards: ReactNode
  /** Region B: the PreviewPanel (browser-chrome + DeviceFrame + iframe). */
  preview: ReactNode
}

/**
 * Desktop preview DRAWER — an absolute right-edge, slide-in push-split shell (Task 5; the mobile overlay
 * is Task 6). It is purely view-state: NO gates, SSE, network, or sandbox attrs live here — the gate cards
 * and the PreviewPanel are passed in verbatim as `cards`/`preview` slots, so this component holds no gate
 * authority and never touches the iframe tag.
 *
 * LAYOUT (H1 — one scrollbar per region): the body is `flex flex-col h-full` with TWO scroll regions —
 * region A (`cards`) is `shrink-0 overflow-y-auto max-h-[50vh]` so the gate stack scrolls on its own, and
 * region B (`preview`) is `flex-1 min-h-0` so the PreviewPanel owns the remaining height (its inner
 * DeviceFrame scrolls). This kills the double-scroll/empty-band bug.
 *
 * RESIZE: a left-edge `role="separator"` handle wired to the keyboard splitter (`onKeyDown`) AND a pointer
 * drag. The drag uses setPointerCapture on the STABLE handle node so it can't die when the cursor crosses
 * the iframe, throttles moves through requestAnimationFrame (one DOM write per frame — SSE-perf parity),
 * and adds `is-dragging` to the drawer so `iframe { pointer-events: none }` (the iframe can't swallow the
 * drag). The drawer doesn't know the container's geometry, so it hands the raw clientX to the parent
 * (`onPointerWidth` live, `commitRatio` on release), which maps it to `--preview-w`/ratio and persists.
 */
export function PreviewDrawer({
  open, ratio, onKeyDown, onPointerWidth, commitRatio, onOpen, onClose, verified, allowAutoOpen = false, cards, preview,
}: PreviewDrawerProps) {
  const { t } = useI18n()
  const drawerId = useId()
  const pct = Math.round(ratio * 100)

  // Live-drag plumbing. We rAF-throttle so a fast pointer doesn't fire a DOM write per pointermove event
  // (matches the SSE fold-per-frame discipline). `latestX` carries the most recent clientX into the frame;
  // `raf` guards a single pending frame; `dragging` short-circuits the moves once capture is released.
  const handleRef = useRef<HTMLDivElement>(null)
  const latestX = useRef(0)
  const raf = useRef<number | null>(null)
  const dragging = useRef(false)

  const flush = useCallback(() => {
    raf.current = null
    if (dragging.current) onPointerWidth(latestX.current)
  }, [onPointerWidth])

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current) return
    latestX.current = e.clientX
    // Coalesce: schedule at most ONE write per frame; later moves just update latestX.
    if (raf.current === null) raf.current = requestAnimationFrame(flush)
  }, [flush])

  const endDrag = useCallback((e: PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null }
    const node = handleRef.current
    if (node) {
      node.classList.remove('is-dragging')
      node.closest('[data-testid="preview-drawer"]')?.classList.remove('is-dragging')
      try { node.releasePointerCapture(e.pointerId) } catch { /* capture may already be gone */ }
    }
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
    commitRatio(e.clientX)
  }, [commitRatio, onPointerMove])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only the primary button starts a resize; let other buttons (context menu etc.) pass through.
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    latestX.current = e.clientX
    const node = handleRef.current
    if (node) {
      // Capture on the STABLE handle node so the drag survives the cursor crossing the iframe.
      try { node.setPointerCapture(e.pointerId) } catch { /* non-fatal: drag still tracked via doc listeners */ }
      node.classList.add('is-dragging')
      node.closest('[data-testid="preview-drawer"]')?.classList.add('is-dragging')
    }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', endDrag)
  }, [onPointerMove, endDrag])

  // Defensive cleanup: if the drawer unmounts mid-drag (e.g. session switch), drop listeners + the frame.
  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
  }, [onPointerMove, endDrag])

  // --- MOBILE OVERLAY (<lg) state. The overlay is a full-screen dialog whose open state is INTERNAL to the
  // drawer (driven by the FAB), NOT the `open` prop — that prop owns the desktop push-split. M1 guard: it is
  // seeded from `allowAutoOpen && open` so a rehydrated `open:true` does NOT auto-show the overlay on a small
  // viewport (the parent passes allowAutoOpen=false there); it requires an explicit FAB tap. We seed once via
  // useState's initializer so a later `open` flip can't retroactively pop the overlay open.
  const [mobileOpen, setMobileOpen] = useState(() => allowAutoOpen && open)
  const fabRef = useRef<HTMLButtonElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const closeMobile = useCallback(() => { onClose(); setMobileOpen(false) }, [onClose])

  // MOBILE A11Y — mirrors ModelPicker VERBATIM in spirit (#10 modal contract): on open, focus moves INTO the
  // panel (first focusable = the ✕); Escape closes; Tab is TRAPPED inside the dialog; body scroll is locked
  // (`overscroll-behavior: contain` so a scroll inside the overlay can't chain to the page); on close, focus
  // is RESTORED to the FAB that opened it. Only wires up while the overlay is actually open.
  useEffect(() => {
    if (!mobileOpen) return
    const panel = overlayRef.current
    const focusables = (): HTMLElement[] =>
      panel ? Array.from(panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')) : []
    focusables()[0]?.focus() // focus the first control on open
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); closeMobile(); return }
      if (e.key !== 'Tab') return
      const f = focusables()
      if (f.length === 0) return
      const first = f[0]!, last = f[f.length - 1]!
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    // Body scroll-lock + overscroll containment while the overlay owns the screen.
    const prevOverflow = document.body.style.overflow
    const prevOverscroll = document.body.style.overscrollBehavior
    document.body.style.overflow = 'hidden'
    document.body.style.overscrollBehavior = 'contain'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      document.body.style.overscrollBehavior = prevOverscroll
      // Restore focus to the FAB that opened the overlay (the modal-a11y contract's exit half).
      fabRef.current?.focus()
    }
  }, [mobileOpen, closeMobile])

  // A Fragment so the collapsed EDGE-TAB (desktop) is a SIBLING of the (aria-hidden) slid-off aside — keeping
  // it in the a11y tree when the drawer is closed (a button inside an aria-hidden subtree would be
  // unreachable). The desktop aside/edge-tab are `hidden lg:*`; the mobile FAB + overlay are `lg:hidden`.
  return (
    <>
    <aside
      data-testid="preview-drawer"
      id={drawerId}
      aria-hidden={!open}
      // Push-split: the parent shifts the chat by `--preview-w`; this drawer fills that strip. translateX
      // 100% slides it fully off-screen when collapsed (the edge-tab stays). `[&.is-dragging_iframe]:…`
      // makes the iframe ignore pointer events DURING a drag so it can't swallow the gesture.
      style={{ transform: open ? 'translateX(0)' : 'translateX(100%)', width: 'var(--preview-w)' }}
      className="absolute inset-y-0 right-0 z-30 hidden flex-col border-l border-white/10 bg-[#0B1220] shadow-2xl transition-transform duration-200 ease-out lg:flex [&.is-dragging_iframe]:pointer-events-none"
    >
      {/* LEFT-EDGE RESIZE SEPARATOR — keyboard splitter + pointer drag (capture on this stable node). */}
      <div
        ref={handleRef}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-controls={drawerId}
        aria-label={t('preview.resize')}
        aria-valuenow={pct}
        aria-valuemin={RATIO_MIN_PCT}
        aria-valuemax={RATIO_MAX_PCT}
        aria-valuetext={fill(t('preview.resizeValue'), { n: String(pct) })}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        style={{ touchAction: 'none' }}
        className="group absolute inset-y-0 left-0 z-10 flex w-3 -translate-x-1/2 cursor-col-resize items-center justify-center focus:outline-none"
      >
        {/* The visible hairline grows on hover/focus — the hit-area (w-3) stays wide for easy grabbing. */}
        <span className="h-full w-px bg-white/10 transition-colors group-hover:bg-[#07D1AF]/60 group-focus:bg-[#07D1AF]" aria-hidden="true" />
      </div>

      {/* HEADER — close (✕). */}
      <div className="flex shrink-0 items-center justify-end border-b border-white/10 px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={t('preview.close')}
          className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50"
        >
          <span aria-hidden="true">✕</span>
        </button>
      </div>

      {/* BODY — two scroll regions (H1). */}
      <div className="flex h-full min-h-0 flex-col">
        {/* Region A: gate-adjacent card stack — owns its own scrollbar, capped so the preview keeps height. */}
        <div className="shrink-0 overflow-y-auto px-3 py-3 [max-height:50vh]">{cards}</div>
        {/* Region B: PreviewPanel — takes the rest; min-h-0 lets its inner DeviceFrame scroll, not the body. */}
        <div className="min-h-0 flex-1">{preview}</div>
      </div>
    </aside>

    {/* COLLAPSED EDGE-TAB — a SIBLING of the (aria-hidden) aside so it stays in the a11y tree when closed.
        It pins to the right viewport edge, reopens the drawer, and carries the verified/unverified dot (L3)
        so the trust state is legible even while the preview is tucked away. Desktop only (Task 6 = mobile). */}
    {!open && (
      <button
        type="button"
        data-testid="preview-edge-tab"
        onClick={onOpen}
        aria-label={t('preview.open')}
        className="absolute right-0 top-1/2 z-40 hidden -translate-y-1/2 items-center gap-1.5 rounded-l-lg border border-r-0 border-white/10 bg-[#0B1220] px-2 py-3 text-slate-300 shadow-lg transition-colors hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50 lg:flex"
      >
        <span
          data-testid="preview-edge-dot"
          data-verified={String(!!verified)}
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${verified ? 'bg-[#07D1AF] shadow-[0_0_6px_rgba(7,209,175,0.7)]' : 'bg-slate-500'}`}
        />
        <span aria-hidden="true" className="text-xs [writing-mode:vertical-rl]">{t('preview.open')}</span>
      </button>
    )}

    {/* MOBILE POCKET FAB (<lg only) — the persistent reachability handle that replaces the old Chat/Preview
        tablist. It toggles the full-screen overlay and carries the verified/unverified dot so the trust state
        is legible even while the preview is pocketed. Always present on small screens (independent of `open`,
        which owns only the desktop push-split). */}
    <button
      ref={fabRef}
      type="button"
      data-testid="preview-fab"
      onClick={() => setMobileOpen(o => !o)}
      aria-label={t('preview.open')}
      aria-expanded={mobileOpen}
      aria-haspopup="dialog"
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-white/10 bg-[#0B1220] px-4 py-3 text-sm font-semibold text-slate-100 shadow-2xl transition-colors hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50 lg:hidden"
    >
      <span
        data-testid="preview-fab-dot"
        data-verified={String(!!verified)}
        aria-hidden="true"
        className={`h-2 w-2 rounded-full ${verified ? 'bg-[#07D1AF] shadow-[0_0_6px_rgba(7,209,175,0.7)]' : 'bg-slate-500'}`}
      />
      <span aria-hidden="true">{t('preview.open')}</span>
    </button>

    {/* MOBILE OVERLAY (<lg only) — a full-screen `role=dialog aria-modal` shell mirroring ModelPicker's a11y
        (Escape close, focus-into-on-open, focus-restore-to-FAB-on-close, body scroll-lock). It reuses the SAME
        two regions (cards + preview) — the slots are rendered a second time here; only one branch is visible
        per breakpoint (CSS `lg:hidden` vs `hidden lg:flex`). Resize is disabled on mobile (no separator). */}
    {mobileOpen && (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('preview.title')}
        className="fixed inset-0 z-50 flex flex-col bg-black/70 lg:hidden"
        // Tapping the scrim (outside the panel) dismisses — inner clicks stopPropagation below.
        onClick={closeMobile}
        // overscroll-behavior:contain so a scroll inside the overlay can't chain to the page underneath.
        style={{ overscrollBehavior: 'contain' }}
      >
        <div
          ref={overlayRef}
          onClick={e => e.stopPropagation()}
          className="flex h-full min-h-0 flex-col border-l border-white/10 bg-[#0B1220] shadow-2xl"
        >
          {/* HEADER — close (✕). */}
          <div className="flex shrink-0 items-center justify-end border-b border-white/10 px-3 py-2">
            <button
              type="button"
              onClick={closeMobile}
              aria-label={t('preview.close')}
              className="rounded-md p-1 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>

          {/* BODY — the same two scroll regions as the desktop drawer (H1). */}
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 overflow-y-auto px-3 py-3 [max-height:50vh]">{cards}</div>
            <div className="min-h-0 flex-1">{preview}</div>
          </div>
        </div>
      </div>
    )}
    </>
  )
}
