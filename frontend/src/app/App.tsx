import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ApiClient } from '../api/client.js'
import { type WorkflowOption } from '../components/NewSessionForm.js'
import { ChatStudio } from '../chat/ChatStudio.js'
import { CosmicBackground } from '../components/CosmicBackground.js'
import { AkisLogo } from '../components/AkisLogo.js'
import { AnalyticsPage } from '../pages/AnalyticsPage.js'
import { DocsPage } from '../pages/DocsPage.js'
import { SettingsPage } from '../pages/SettingsPage.js'
import { Login } from '../pages/Login.js'
import { Signup } from '../pages/Signup.js'
import { I18nProvider, useI18n } from '../i18n/I18nContext.js'
import { RouterProvider, useRouter, Link, Navigate } from '../router/router.js'
import { AuthProvider, useAuth } from '../auth/AuthContext.js'

/** API base: same-origin in prod (fastify-static serves the FE); override via env in dev. */
const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? ''

function Brand() {
  const { t } = useI18n()
  return (
    <Link to="/" className="flex items-center gap-3">
      <AkisLogo size={34} className="drop-shadow-[0_0_16px_rgba(7,209,175,0.5)]" />
      <div className="hidden sm:block">
        <div className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-base font-extrabold leading-tight text-transparent">{t('app.title')}</div>
      </div>
    </Link>
  )
}

function NavLink({ to, label }: { to: string; label: string }) {
  const { path } = useRouter()
  const active = path === to
  return (
    <Link to={to} className={`rounded-lg px-3 py-1.5 text-sm transition ${active ? 'bg-white/10 text-slate-100' : 'text-slate-400 hover:text-slate-200'}`}>{label}</Link>
  )
}

/** The authenticated app frame: cosmic backdrop, top nav, and the routed page. */
function AppFrame({ api }: { api: ApiClient }) {
  const { t, locale, setLocale } = useI18n()
  const { path } = useRouter()
  const { user, logout } = useAuth()
  const [workflows, setWorkflows] = useState<WorkflowOption[]>([])
  useEffect(() => { void api.listWorkflows().then(ws => setWorkflows(ws.map(w => ({ id: w.id, name: w.name })))).catch(() => {}) }, [api, path])

  const page = path === '/analytics' ? <AnalyticsPage api={api} />
    : path === '/settings' ? <SettingsPage api={api} />
    : path === '/docs' ? <DocsPage />
    : path === '/' ? <ChatStudio api={api} baseUrl={BASE} workflows={workflows} />
    : <Navigate to="/" />

  return (
    <div className="relative min-h-screen text-slate-100">
      <CosmicBackground />
      <div className="relative z-10 mx-auto max-w-6xl px-6 py-6">
        <header className="mb-6 flex items-center justify-between gap-4">
          <Brand />
          <nav className="flex items-center gap-1">
            <NavLink to="/" label={t('nav.dashboard')} />
            <NavLink to="/analytics" label={t('nav.analytics')} />
            <NavLink to="/settings" label={t('nav.settings')} />
            <NavLink to="/docs" label={t('nav.docs')} />
          </nav>
          <div className="flex items-center gap-2">
            <button onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-slate-300 hover:border-white/20">{locale.toUpperCase()}</button>
            <div className="hidden text-right sm:block">
              <div className="text-xs font-medium text-slate-200">{user?.name}</div>
            </div>
            <button onClick={() => void logout()} title={t('nav.logout')}
              className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-xs font-black text-slate-950">
              {(user?.name ?? '?').slice(0, 1).toUpperCase()}
            </button>
          </div>
        </header>
        {page}
      </div>
    </div>
  )
}

/** Cosmic frame for the public auth pages. */
function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen text-slate-100">
      <CosmicBackground />
      <div className="relative z-10">{children}</div>
    </div>
  )
}

function Loader() {
  const { t } = useI18n()
  return (
    <div className="relative min-h-screen text-slate-100">
      <CosmicBackground />
      <div className="relative z-10 grid min-h-screen place-items-center">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#07D1AF]/40 border-t-[#07D1AF]" />{t('common.loading')}
        </div>
      </div>
    </div>
  )
}

function Shell({ api }: { api: ApiClient }) {
  const { user, loading } = useAuth()
  const { path } = useRouter()
  if (loading) return <Loader />
  if (path === '/login') return user ? <Navigate to="/" /> : <PublicFrame><Login /></PublicFrame>
  if (path === '/signup') return user ? <Navigate to="/" /> : <PublicFrame><Signup /></PublicFrame>
  if (!user) return <PublicFrame><Navigate to="/login" /></PublicFrame>
  return <AppFrame api={api} />
}

export function App() {
  const api = useMemo(() => new ApiClient(BASE), [])
  return (
    <I18nProvider>
      <RouterProvider>
        <AuthProvider api={api}>
          <Shell api={api} />
        </AuthProvider>
      </RouterProvider>
    </I18nProvider>
  )
}
