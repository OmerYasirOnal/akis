import { useEffect, useState } from 'react'
import type { ApiClient, ProviderInfo } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { SectionTitle, Button, Input, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

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
    try { await api.setProviderKey(id, key); setDrafts(d => ({ ...d, [id]: '' })); load() }
    catch (e) { setErr(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(undefined) }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(id); setErr(undefined)
    try { await api.removeProviderKey(id); load() }
    catch (e) { setErr(ApiError.is(e) ? `${e.code ?? 'error'}: ${e.message}` : String(e)) }
    finally { setBusy(undefined) }
  }

  return (
    <div>
      <SectionTitle sub={t('settings.keys.sub')}>{t('settings.keys.title')}</SectionTitle>
      {err && <div className="mb-3"><ErrorNote>{err}</ErrorNote></div>}
      <div className="flex flex-col gap-3">
        {providers.map(p => (
          <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-white/[0.02] p-3">
            <div className="w-28 shrink-0">
              <div className="text-sm font-semibold text-slate-100">{p.label}</div>
              <div className={`text-xs ${p.available ? 'text-[#07D1AF]' : 'text-slate-500'}`}>
                {p.available ? `${t('settings.keys.connected')}${p.last4 ? ` · ••••${p.last4}` : ''}` : t('settings.keys.notConnected')}
              </div>
            </div>
            <Input type="password" aria-label={`${p.label} key`} value={drafts[p.id] ?? ''} placeholder={t('settings.keys.placeholder')}
              onChange={e => setDrafts(d => ({ ...d, [p.id]: e.target.value }))} className="min-w-0 flex-1" />
            <Button variant="ghost" onClick={() => void save(p.id)} disabled={busy === p.id || !(drafts[p.id] ?? '').trim()}>{t('settings.keys.save')}</Button>
            {p.last4 && <Button variant="subtle" onClick={() => void remove(p.id)} disabled={busy === p.id}>{t('settings.keys.remove')}</Button>}
          </div>
        ))}
      </div>
    </div>
  )
}
