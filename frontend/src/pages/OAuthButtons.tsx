import { useEffect, useState, type ReactNode } from 'react'
import type { ApiClient } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import { Spinner } from '../ui/kit.js'

/** The GitHub mark — exported so the account menu's "Signed in via GitHub" line reuses the SAME glyph. */
export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** The Google mark — the official 4-color "G" so the sign-in CTA uses Google's real,
 *  recognizable brand glyph (not a made-up disc). Exported so the account menu's
 *  "Signed in via Google" line reuses the SAME mark. */
export function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  )
}

/** One provider anchor. Clicking does a full-page redirect into the OAuth flow; on click it
 *  swaps the provider glyph for a spinner + sets aria-busy, so a slow IdP redirect reads as
 *  "working" instead of an inert button (the full-page nav clears the state). */
function ProviderLink({ href, mark, label, busy, onClick }: { href: string; mark: ReactNode; label: string; busy: boolean; onClick: () => void }) {
  return (
    <a href={href} onClick={onClick} aria-busy={busy || undefined}
      className="flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:border-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
      {busy ? <Spinner /> : mark} {label}
    </a>
  )
}

/** "Continue with GitHub/Google" — only renders providers the server reports as
 *  configured. Clicking does a full-page redirect into the OAuth flow. */
export function OAuthButtons({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<string[]>([])
  const [redirecting, setRedirecting] = useState<string | null>(null)
  // `?? []` so a malformed/partial response degrades to "no buttons" rather than crashing the
  // auth page on `undefined.length` (honest absence beats a white screen).
  useEffect(() => { void api.getOAuthProviders().then(r => setProviders(r.providers ?? [])).catch(() => setProviders([])) }, [api])
  if (providers.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {providers.includes('github') && (
          <ProviderLink href={api.oauthAuthorizeUrl('github')} mark={<GitHubMark />} label={t('auth.oauth.github')}
            busy={redirecting === 'github'} onClick={() => setRedirecting('github')} />
        )}
        {providers.includes('google') && (
          <ProviderLink href={api.oauthAuthorizeUrl('google')} mark={<GoogleMark />} label={t('auth.oauth.google')}
            busy={redirecting === 'google'} onClick={() => setRedirecting('google')} />
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-white/10" />{t('auth.or')}<span className="h-px flex-1 bg-white/10" />
      </div>
    </div>
  )
}
