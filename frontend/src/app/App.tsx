import { useMemo, useState } from 'react'
import { ApiClient } from '../api/client.js'
import { NewSessionForm } from '../components/NewSessionForm.js'
import { SessionView } from '../components/SessionView.js'

/** API base: same-origin in prod (fastify-static serves the FE); override via env in dev. */
const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? ''

export function App() {
  const api = useMemo(() => new ApiClient(BASE), [])
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)

  const start = async (idea: string): Promise<void> => {
    setBusy(true)
    try { const s = await api.startSession(idea); setSessionId(s.id) }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-6">
          <h1 className="bg-gradient-to-r from-cyan-300 to-violet-400 bg-clip-text text-2xl font-bold text-transparent">
            AKIS · agentic build studio
          </h1>
          <p className="text-sm text-slate-500">Describe an app → agents build, verify with real tests, and ship it. Watch it live.</p>
        </header>
        <div className="mb-8"><NewSessionForm onStart={start} busy={busy} /></div>
        {sessionId
          ? <SessionView sessionId={sessionId} api={api} baseUrl={BASE} />
          : <p className="text-slate-600">Start a build to see the live agent flow.</p>}
      </div>
    </div>
  )
}
