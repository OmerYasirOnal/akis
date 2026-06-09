import { useEffect, useRef, useState } from 'react'
import { ideaTitle, type RecentBuild } from './recentBuilds.js'
import { statusSignal } from './statusLabel.js'
import { useI18n } from '../i18n/I18nContext.js'

/** SVG clock + chevron — OS-independent, on-brand (vs the platform-default emoji glyphs). */
function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  )
}
function ChevronDown() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/**
 * An always-visible build-history affordance for the Studio header — a "History" button
 * that opens a dropdown of recent builds. Visible even during an active build (fixes the
 * discoverability gap where recents only showed on the empty studio). Clicking a build
 * calls onOpen (→ ChatStudio.openSession). Closes on outside-click / Escape.
 */
export function HistoryMenu({ builds, onOpen }: { builds: RecentBuild[]; onOpen: (b: RecentBuild) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // The trigger button — Escape (and outside-click is mouse) returns focus here so keyboard users
  // aren't dropped onto <body> when the menu closes (mirrors ModelPicker's prevFocus restore).
  const triggerRef = useRef<HTMLButtonElement>(null)
  // The popup panel — keyboard nav queries its live [role=menuitem] elements (ModelPicker idiom:
  // read the rendered DOM at event time rather than maintaining a parallel ref array).
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    // MENU A11Y: roving focus across [role=menuitem]. On open, focus the first item. Arrow keys move
    // (clamped, matching ModelPicker's non-wrapping Tab trap), Home/End jump to the ends, Escape
    // closes + restores focus to the trigger. Mouse/click selection is untouched.
    const items = (): HTMLElement[] => menuRef.current ? Array.from(menuRef.current.querySelectorAll<HTMLElement>('[role="menuitem"]')) : []
    items()[0]?.focus() // focus the first item on open
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); return }
      const f = items()
      if (f.length === 0) return
      const idx = f.findIndex(el => el === document.activeElement)
      if (e.key === 'ArrowDown') { e.preventDefault(); f[Math.min(idx + 1, f.length - 1)]?.focus() }
      else if (e.key === 'ArrowUp') { e.preventDefault(); f[Math.max(idx - 1, 0)]?.focus() }
      else if (e.key === 'Home') { e.preventDefault(); f[0]?.focus() }
      else if (e.key === 'End') { e.preventDefault(); f[f.length - 1]?.focus() }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        // RESPONSIVE (mobile-first): below `sm` this collapses to a compact icon button (the label is
        // hidden so the studio header fits one tidy row at 320px) with a ≥44px square tap box (WCAG
        // 2.5.5); the clock glyph carries the meaning and `aria-label` names it for AT. From `sm` the
        // visible "Recent/Son derlemeler" label + chevron return. The chevron is hidden when the label
        // is (it has no meaning beside a lone icon).
        aria-label={t('history.button')}
        className="flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-white/10 px-2.5 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/50 sm:h-auto sm:min-w-0 sm:py-1.5"
      >
        <ClockIcon />
        <span className="hidden sm:inline">{t('history.button')}</span>
        <span className="hidden sm:inline"><ChevronDown /></span>
      </button>
      {open && (
        <div ref={menuRef} role="menu" className="absolute right-0 z-20 mt-1 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/95 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md sm:max-h-96 sm:w-96">
          {builds.length === 0
            ? <div className="px-3 py-3 text-xs text-slate-500">{t('history.empty')}</div>
            : builds.map(b => (
              <button
                key={b.id}
                role="menuitem"
                onClick={() => { setOpen(false); onOpen(b) }}
                className="block w-full rounded-lg px-3 py-2 text-left text-xs text-slate-300 transition hover:bg-white/5 hover:text-slate-100"
                title={b.idea}
              >
                {/* P1-7: the menu carries the SAME minimal signal as the History page — title +
                    localized status pill + verified mark — not just the bare title. */}
                <div className="truncate">{ideaTitle(b.idea) || t('history.untitled')}</div>
                {(b.status || b.verified) && (
                  <div className="mt-1 flex items-center gap-1.5">
                    {b.status && (
                      <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusSignal(b.status).tone}`}>
                        {t(statusSignal(b.status).labelKey)}
                      </span>
                    )}
                    {b.verified && <span className="text-[10px] font-medium text-emerald-300">✓ {t('history.verified')}</span>}
                  </div>
                )}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
