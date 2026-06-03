import { useEffect, useRef, useState } from 'react'
import { ideaTitle, type RecentBuild } from './recentBuilds.js'
import { useI18n } from '../i18n/I18nContext.js'

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

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex shrink-0 items-center gap-1.5 rounded border border-white/10 px-2 py-0.5 text-xs text-slate-400 transition hover:border-white/20 hover:text-slate-200"
      >
        <span aria-hidden>🕘</span> {t('history.button')}
        <span aria-hidden className="text-[9px]">▾</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/95 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md">
          {builds.length === 0
            ? <div className="px-3 py-3 text-xs text-slate-500">{t('history.empty')}</div>
            : builds.map(b => (
              <button
                key={b.id}
                role="menuitem"
                onClick={() => { setOpen(false); onOpen(b) }}
                className="block w-full truncate rounded-lg px-3 py-2 text-left text-xs text-slate-300 transition hover:bg-white/5 hover:text-slate-100"
                title={b.idea}
              >
                {ideaTitle(b.idea) || t('history.untitled')}
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
