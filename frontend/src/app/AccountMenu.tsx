import { useEffect, useRef, useState } from 'react'
import type { AuthUser } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { useRouter } from '../router/router.js'
import { GitHubMark, GoogleMark } from '../pages/OAuthButtons.js'

/** The provider line config — picks the localized "Signed in via …" label + the matching glyph.
 *  Defaults to 'password' (Email account) when the projection lacks `provider` (older sessions). */
function providerLine(provider: AuthUser['provider']): { labelKey: 'account.via.github' | 'account.via.google' | 'account.via.password'; mark: 'github' | 'google' | null } {
  if (provider === 'github') return { labelKey: 'account.via.github', mark: 'github' }
  if (provider === 'google') return { labelKey: 'account.via.google', mark: 'google' }
  return { labelKey: 'account.via.password', mark: null }
}

/** The avatar trigger: the REAL provider photo when present, falling back to the gradient
 *  letter circle on a missing/empty url OR an image load error. The same visual is reused in
 *  the menu header. `failed` flips on the <img>'s onError so a broken/expired url degrades
 *  gracefully to the initial instead of a broken-image glyph. */
function Avatar({ user, size }: { user: AuthUser; size: 'sm' | 'md' }) {
  const [failed, setFailed] = useState(false)
  const box = size === 'sm' ? 'h-8 w-8' : 'h-9 w-9'
  const initial = (user.name || '?').slice(0, 1).toUpperCase()
  // Show the photo only when we have a non-empty url AND it hasn't errored.
  if (user.avatarUrl && !failed) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        onError={() => setFailed(true)}
        className={`${box} rounded-full object-cover`}
      />
    )
  }
  return (
    <span className={`grid ${box} place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-xs font-black text-slate-950`}>
      {initial}
    </span>
  )
}

/** Small leading glyphs for the menu items (decorative — the label names the item). */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.2.61.76 1.05 1.42 1.05H21a2 2 0 0 1 0 4h-.09c-.66 0-1.22.44-1.51 1.05Z" />
    </svg>
  )
}
function LogOutIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" />
    </svg>
  )
}

/**
 * The account dropdown that REPLACES the old avatar-instant-logout button. The avatar is now a
 * pure menu TRIGGER (clicking it no longer signs out) — the menu carries provider awareness
 * (the real photo + a "Signed in via …" line), a Settings link, and the Sign-out action.
 *
 * Reuses the HistoryMenu dropdown pattern verbatim (click-outside + Escape close, role="menu"/
 * menuitem, absolute glass panel). Settings navigates through the SAME history-API router the
 * header nav links use (useRouter().navigate), so it can't full-reload the app.
 */
export function AccountMenu({ user, logout }: { user: AuthUser; logout: () => void | Promise<void> }) {
  const { t } = useI18n()
  const { navigate } = useRouter()
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

  const line = providerLine(user.provider)

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('account.menuLabel')}
        className="grid place-items-center rounded-full outline-none ring-offset-2 ring-offset-slate-950 focus-visible:ring-2 focus-visible:ring-[#07D1AF]"
      >
        <Avatar user={user} size="sm" />
      </button>
      {open && (
        <div role="menu" aria-label={t('account.menuLabel')} className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-white/10 bg-slate-950/95 p-1.5 shadow-[0_12px_40px_rgba(0,0,0,0.55)] backdrop-blur-md">
          {/* Header: avatar + name + email (both truncated so a long email never blows out the panel). */}
          <div className="flex items-center gap-3 px-2.5 py-2">
            <Avatar user={user} size="md" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-slate-100">{user.name}</div>
              <div className="truncate text-xs text-slate-400">{user.email}</div>
            </div>
          </div>
          {/* Provider line: real glyph + localized "Signed in via …" (or "Email account"). */}
          <div className="flex items-center gap-2 px-2.5 pb-2 text-xs text-slate-400">
            {line.mark === 'github' && <span className="text-slate-300"><GitHubMark /></span>}
            {line.mark === 'google' && <GoogleMark />}
            <span>{t(line.labelKey)}</span>
          </div>
          {/* One divider separates the identity block from the actions. The destructive Sign-out
              is distinguished by a leading icon + a muted-rose hover, not a second hairline. */}
          <div className="my-1 h-px bg-white/10" />
          <button
            role="menuitem"
            onClick={() => { setOpen(false); navigate('/settings') }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-slate-300 transition hover:bg-white/5 hover:text-slate-100"
          >
            <GearIcon /> {t('nav.settings')}
          </button>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); void logout() }}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-slate-300 transition hover:bg-rose-500/10 hover:text-rose-300"
          >
            <LogOutIcon /> {t('nav.logout')}
          </button>
        </div>
      )}
    </div>
  )
}
