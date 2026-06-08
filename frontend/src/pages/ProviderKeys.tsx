import { useEffect, useState } from 'react'
import type { ApiClient, ProviderInfo } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { invalidateProvidersCache } from '../api/providersCache.js'
import { SectionTitle, Button, Input, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Fill {provider} in a catalog template (same local idiom as PreviewDrawer/AgentWriteProposals —
 *  i18n keeps the template; the FE interpolates at render). */
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)

/** Self-serve provider-key management — connect/remove your own AI keys (stored
 *  encrypted server-side; the response only ever returns the last 4 chars). */
export function ProviderKeys({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | undefined>()
  const [err, setErr] = useState<string | undefined>()

  const load = (): void => { void api.listProviders().then(setProviders).catch(() => setProviders([])) }
  useEffect(load, [api])

  const save = async (id: string): Promise<void> => {
    const key = (drafts[id] ?? '').trim(); if (!key) return
    setBusy(id); setErr(undefined)
    try { await api.setProviderKey(id, key); invalidateProvidersCache(api); setDrafts(d => ({ ...d, [id]: '' })); load() }
    catch (e) { setErr(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(undefined) }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(id); setErr(undefined)
    try { await api.removeProviderKey(id); invalidateProvidersCache(api); load() }
    catch (e) { setErr(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(undefined) }
  }

  return (
    <div>
      <SectionTitle sub={t('settings.keys.sub')}>{t('settings.keys.title')}</SectionTitle>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}
      <div className="flex flex-col gap-3">
        {/* Explicit responsive grid (not flex-wrap, which orphaned the Save button onto a new line
            under the input): stacked label/input/actions on mobile; a 7rem · 1fr · auto single row
            from sm. The action buttons are grouped so they never split. */}
        {providers.map(p => (
          <div key={p.id} className="grid grid-cols-1 gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-center">
            <div>
              <div className="text-sm font-semibold text-slate-100">{p.label}</div>
              <div className={`text-xs ${p.available ? 'text-[#07D1AF]' : 'text-slate-400'}`}>
                {p.available ? `${t('settings.keys.connected')}${p.last4 ? ` · ••••${p.last4}` : ''}` : t('settings.keys.notConnected')}
              </div>
            </div>
            <Input type="password" aria-label={fill(t('settings.keys.aria'), { provider: p.label })} value={drafts[p.id] ?? ''} placeholder={t('settings.keys.placeholder')}
              onChange={e => setDrafts(d => ({ ...d, [p.id]: e.target.value }))} className="min-w-0" />
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" onClick={() => void save(p.id)} disabled={busy === p.id || !(drafts[p.id] ?? '').trim()}>{t('settings.keys.save')}</Button>
              {p.last4 && <Button variant="subtle" onClick={() => void remove(p.id)} disabled={busy === p.id}>{t('settings.keys.remove')}</Button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
