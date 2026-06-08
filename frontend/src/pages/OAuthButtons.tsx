import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'

const ICON: Record<string, string> = { github: '', google: 'G' } // simple glyphs; GitHub uses an SVG below

/** The GitHub mark — exported so the account menu's "Signed in via GitHub" line reuses the SAME glyph. */
export function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** The Google glyph used on the sign-in button — exported so the account menu reuses the SAME mark. */
export function GoogleMark() {
  return (
    <span className="grid h-4 w-4 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-[10px] font-black text-slate-950">{ICON.google}</span>
  )
}

/** "Continue with GitHub/Google" — only renders providers the server reports as
 *  configured. Clicking does a full-page redirect into the OAuth flow. */
export function OAuthButtons({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<string[]>([])
  useEffect(() => { void api.getOAuthProviders().then(r => setProviders(r.providers)).catch(() => setProviders([])) }, [api])
  if (providers.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {providers.includes('github') && (
          <a href={api.oauthAuthorizeUrl('github')}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-100 hover:border-white/30">
            <GitHubMark /> {t('auth.oauth.github')}
          </a>
        )}
        {providers.includes('google') && (
          <a href={api.oauthAuthorizeUrl('google')}
            className="flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-slate-100 hover:border-white/30">
            <GoogleMark /> {t('auth.oauth.google')}
          </a>
        )}
      </div>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span className="h-px flex-1 bg-white/10" />{t('auth.or')}<span className="h-px flex-1 bg-white/10" />
      </div>
    </div>
  )
}
