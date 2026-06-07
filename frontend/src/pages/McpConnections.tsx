import { useEffect, useState } from 'react'
import type { ApiClient, McpConnectionStatus } from '../api/client.js'
import { SectionTitle, Button, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/** The providers AKIS can connect over the remote-MCP browser-OAuth flow. `label` is display-only;
 *  `id` matches the server's REMOTE_MCP_PROVIDERS key + the /mcp/:provider/* routes. */
const PROVIDERS: ReadonlyArray<{ id: string; label: string; blurbKey: 'settings.mcp.blurb.atlassian' | 'settings.mcp.blurb.github' }> = [
  { id: 'atlassian', label: 'Jira / Confluence', blurbKey: 'settings.mcp.blurb.atlassian' },
  { id: 'github', label: 'GitHub (MCP)', blurbKey: 'settings.mcp.blurb.github' },
]

type Banner = 'connected' | 'error' | 'denied' | 'unavailable' | 'unknown'

/**
 * Per-user REMOTE MCP connections (the "agents really use MCP" UX). Connect YOUR Atlassian / GitHub
 * via a browser OAuth flow — no token to paste; for Atlassian no app to register (the server drives
 * Dynamic Client Registration). Tokens never reach the browser; only the connection status shows.
 * WRITES (Jira issues / Confluence pages) still require an explicit per-write human confirm.
 */
export function McpConnections({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<Record<string, McpConnectionStatus | undefined>>({})
  const [busy, setBusy] = useState<string | undefined>()
  const [err, setErr] = useState<string | undefined>()
  const [banner, setBanner] = useState<Banner | undefined>()

  const load = (): void => {
    for (const p of PROVIDERS) {
      void api.mcpStatus(p.id).then(s => setStatus(prev => ({ ...prev, [p.id]: s }))).catch(() => setStatus(prev => ({ ...prev, [p.id]: { connected: false } })))
    }
  }
  useEffect(load, [api])

  // Read the post-redirect ?mcp= signal once, then strip it (no navigation), like the GitHub card.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const m = new URLSearchParams(window.location.search).get('mcp')
    if (m === 'connected' || m === 'error' || m === 'denied' || m === 'unavailable' || m === 'unknown') {
      setBanner(m)
      const url = new URL(window.location.href)
      url.searchParams.delete('mcp')
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  const disconnect = async (id: string): Promise<void> => {
    if (typeof window !== 'undefined' && !window.confirm(t('settings.mcp.confirmDisconnect'))) return
    setBusy(id); setErr(undefined)
    try { await api.disconnectMcp(id); load() }
    catch (e) { setErr(String(e)) }
    finally { setBusy(undefined) }
  }

  return (
    <div>
      <SectionTitle sub={t('settings.mcp.sub')}>{t('settings.mcp.title')}</SectionTitle>

      {banner && (
        <div className="mb-3">
          {banner === 'connected'
            ? <div role="status" className="rounded-lg border border-[#07D1AF]/30 bg-[#07D1AF]/10 px-3 py-2 text-sm text-[#07D1AF]">{t('settings.mcp.ok.connected')}</div>
            : <ErrorNote>{t(`settings.mcp.err.${banner}` as 'settings.mcp.err.error')}</ErrorNote>}
        </div>
      )}
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}

      <div className="flex flex-col gap-3">
        {PROVIDERS.map(p => {
          const s = status[p.id]
          const connected = s?.connected === true
          return (
            <div key={p.id} className="flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="min-w-0">
                <div className="font-semibold text-slate-100">{p.label}</div>
                <div className="truncate text-sm text-slate-400">{connected ? t('settings.mcp.connected') : t(p.blurbKey)}</div>
                {/* Parity with the GitHub card: surface the GRANTED (non-secret) scopes so the owner can
                    confirm what they authorised (e.g. write:confluence-content). Never a token. */}
                {connected && s?.scopes && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.scopes.split(/\s+/).filter(Boolean).map(sc => (
                      <span key={sc} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-slate-400">{sc}</span>
                    ))}
                  </div>
                )}
              </div>
              {connected
                ? <Button variant="ghost" onClick={() => void disconnect(p.id)} disabled={busy === p.id}>{t('settings.mcp.disconnect')}</Button>
                : <a href={api.mcpConnectUrl(p.id)} className="shrink-0 rounded-lg bg-[#07D1AF] px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-[#07D1AF]/90">{t('settings.mcp.connect')}</a>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
