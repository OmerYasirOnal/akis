import { useMemo, useState } from 'react'
import { ApiClient } from '../api/client.js'
import { NewSessionForm } from '../components/NewSessionForm.js'
import { SessionView } from '../components/SessionView.js'
import { AgentsTab } from '../agents/AgentsTab.js'
import { I18nProvider, useI18n } from '../i18n/I18nContext.js'

/** API base: same-origin in prod (fastify-static serves the FE); override via env in dev. */
const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? ''

function Studio() {
  const { t, locale, setLocale } = useI18n()
  const api = useMemo(() => new ApiClient(BASE), [])
  const [tab, setTab] = useState<'build' | 'agents'>('build')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const start = async (idea: string): Promise<void> => {
    setBusy(true)
    try { const s = await api.startSession(idea); setSessionId(s.id) }
    finally { setBusy(false) }
  }

  const tabBtn = (id: 'build' | 'agents', label: string) => (
    <button onClick={() => setTab(id)}
      className={`rounded px-3 py-1 text-sm ${tab === id ? 'bg-white/10 text-slate-100' : 'text-slate-500 hover:text-slate-300'}`}>{label}</button>
  )

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="bg-gradient-to-r from-cyan-300 to-violet-400 bg-clip-text text-2xl font-bold text-transparent">{t('app.title')}</h1>
            <p className="text-sm text-slate-500">{t('app.subtitle')}</p>
          </div>
          <button onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')} className="rounded border border-white/10 px-2 py-1 text-xs text-slate-400">
            {locale.toUpperCase()}
          </button>
        </header>

        <nav className="mb-6 flex gap-2">{tabBtn('build', t('tab.build'))}{tabBtn('agents', t('tab.agents'))}</nav>

        {tab === 'build' ? (
          <>
            <div className="mb-8"><NewSessionForm onStart={start} busy={busy} /></div>
            {sessionId ? <SessionView sessionId={sessionId} api={api} baseUrl={BASE} /> : <p className="text-slate-600">Start a build to see the live agent flow.</p>}
          </>
        ) : (
          <AgentsTab api={api} />
        )}
      </div>
    </div>
  )
}

export function App() {
  return <I18nProvider><Studio /></I18nProvider>
}
