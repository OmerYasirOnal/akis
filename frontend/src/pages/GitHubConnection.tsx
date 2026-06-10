import { useEffect, useState } from 'react'
import type { ApiClient, GitHubConnectionStatus } from '../api/client.js'
import { SectionTitle, Button, Input, ErrorNote, EmptyState } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/** A one-line banner keyed off `?github=…` on the Settings URL after the OAuth round-trip.
 *  Maps the four signals to a localized success/error message; cleared from the URL after. */
type Banner = 'connected' | 'error' | 'denied' | 'unavailable'
const BANNER_OK: Banner[] = ['connected']

// Client-side "owner/name" shape check — mirrors the server's parseOwnerRepo (selectGitHubAdapter.ts)
// so a malformed target is caught BEFORE the OAuth round-trip (which would otherwise bounce off
// github.com and return ?github=error with no inline explanation). Exactly one slash; owner is a
// GitHub login (1–39 alnum/hyphen, no leading/trailing hyphen); name is alnum/._- (no '..'/trailing dot).
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/
function isValidRepo(s: string): boolean {
  const t = s.trim()
  if (t.indexOf('/') === -1 || t.indexOf('/') !== t.lastIndexOf('/')) return false
  const owner = t.slice(0, t.indexOf('/'))
  const name = t.slice(t.indexOf('/') + 1)
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name)) return false
  if (name === '.' || name === '..' || name.includes('..') || name.endsWith('.')) return false
  return true
}

/** Per-user GitHub connection card. Connect YOUR GitHub so AKIS ships verified builds to a
 *  repo YOU own (the gated push then targets that repo instead of the server-wide env token).
 *  The token never reaches the browser — only the connection status (username/repo/scopes). */
export function GitHubConnection({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<GitHubConnectionStatus | undefined>()
  const [repo, setRepo] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const [banner, setBanner] = useState<Banner | undefined>()
  const validRepo = isValidRepo(repo)

  const load = (): void => { void api.githubStatus().then(setStatus).catch(() => setStatus({ connected: false, configured: false })) }
  useEffect(load, [api])

  // Read the post-redirect signal once, then strip it from the URL so a refresh doesn't
  // re-show it (history.replaceState — no navigation).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const g = new URLSearchParams(window.location.search).get('github')
    if (g === 'connected' || g === 'error' || g === 'denied' || g === 'unavailable') {
      setBanner(g)
      const url = new URL(window.location.href)
      url.searchParams.delete('github')
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  const disconnect = async (): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm(t('settings.github.confirmDisconnect'))) return
    setBusy(true); setErr(undefined)
    try { await api.disconnectGitHub(); load() }
    catch (e) { setErr(String(e)) }
    finally { setBusy(false) }
  }

  return (
    <div>
      <SectionTitle sub={t('settings.github.sub')}>{t('settings.github.title')}</SectionTitle>

      {banner && (
        <div className="mb-3">
          {BANNER_OK.includes(banner)
            ? <div role="status" className="rounded-lg border border-[#07D1AF]/30 bg-[#07D1AF]/10 px-3 py-2 text-sm text-[#07D1AF]">{t('settings.github.ok.connected')}</div>
            : <ErrorNote>{t(`settings.github.err.${banner}` as 'settings.github.err.error')}</ErrorNote>}
        </div>
      )}
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      {/* While the first status fetch is in flight (status still undefined, before the catch sets a
          default) show an inline spinner row — mirrors HistoryPage — so a slow link never leaves a
          blank card body. (preview-drawer loading state + round-2 EmptyState, both kept.) */}
      {status === undefined ? (
        <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-3 py-4 text-sm text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#07D1AF]/40 border-t-[#07D1AF]" />
          {t('settings.loading')}
        </div>
      ) : !status.configured ? (
        <EmptyState>{t('settings.github.notConfigured')}</EmptyState>
      ) : status.connected ? (
        <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <span className="text-slate-400">{t('settings.github.username')}</span>
            <span className="text-slate-100">{status.username || '—'}</span>
            <span className="text-slate-400">{t('settings.github.repoLabel')}</span>
            <span className="font-mono text-slate-100">{status.repo || '—'}</span>
            {status.scopes && status.scopes.length > 0 && (<>
              <span className="text-slate-400">{t('settings.github.scopes')}</span>
              <span className="flex flex-wrap gap-1">
                {status.scopes.map(s => <span key={s} className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-slate-300">{s}</span>)}
              </span>
            </>)}
            {status.connectedAt && (<>
              <span className="text-slate-400">{t('settings.github.connectedAt')}</span>
              <span className="text-slate-300">{new Date(status.connectedAt).toLocaleString()}</span>
            </>)}
          </div>
          <div>
            <Button variant="subtle" onClick={() => void disconnect()} disabled={busy}>{t('settings.github.disconnect')}</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Input aria-label={t('settings.github.repoLabel')} value={repo} placeholder={t('settings.github.repoPlaceholder')}
              onChange={e => setRepo(e.target.value)} className="min-w-0 flex-1" />
            {/* Full-page redirect into the connect flow (never an XHR — it leaves the SPA for
                github.com and returns to /settings?github=…). Enabled ONLY for a valid "owner/name"
                so a malformed target never burns an OAuth round-trip that returns ?github=error. */}
            <a
              href={validRepo ? api.githubConnectUrl(repo.trim()) : undefined}
              aria-disabled={!validRepo}
              className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${validRepo
                ? 'bg-gradient-to-r from-[#07D1AF] to-violet-500 text-slate-950 shadow-[0_0_22px_rgba(7,209,175,0.35)] hover:brightness-110'
                : 'pointer-events-none cursor-not-allowed border border-white/10 bg-white/[0.03] text-slate-500'}`}
            >
              {t('settings.github.connect')}
            </a>
          </div>
          {/* Inline shape error ONLY once the user has typed something malformed (an empty box is just
              the disabled default, not an error). The hint below always explains the create-if-missing behavior. */}
          {repo.trim() && !validRepo && <span className="text-xs text-rose-300">{t('settings.github.repoInvalid')}</span>}
          <span className="text-xs text-slate-500">{t('settings.github.repoHint')}</span>
        </div>
      )}
    </div>
  )
}
