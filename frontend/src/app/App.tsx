import { useEffect, useMemo, useState, lazy, Suspense, type ReactNode } from 'react'
import { ApiClient } from '../api/client.js'
import { CosmicBackground } from '../components/CosmicBackground.js'
import { AkisLogo } from '../components/AkisLogo.js'
// CODE-SPLIT (audit bigger-bet): the studio + the secondary authed pages are lazy so a logged-out
// visitor on Landing/Login never downloads the full app, and each authed route loads on demand
// (its own chunk, cached). The pre-auth pages (Login/Signup/Landing/…) stay EAGER — they are the
// critical first-paint path and must not flash a fallback. Rendered inside a <Suspense>.
const ChatStudio = lazy(() => import('../chat/ChatStudio.js').then(m => ({ default: m.ChatStudio })))
const AnalyticsPage = lazy(() => import('../pages/AnalyticsPage.js').then(m => ({ default: m.AnalyticsPage })))
const HistoryPage = lazy(() => import('../pages/HistoryPage.js').then(m => ({ default: m.HistoryPage })))
const DocsPage = lazy(() => import('../pages/DocsPage.js').then(m => ({ default: m.DocsPage })))
const SettingsPage = lazy(() => import('../pages/SettingsPage.js').then(m => ({ default: m.SettingsPage })))
const WorkflowsPage = lazy(() => import('../workflows/WorkflowsPage.js').then(m => ({ default: m.WorkflowsPage })))
import { Login } from '../pages/Login.js'
import { Signup } from '../pages/Signup.js'
import { Landing } from '../pages/Landing.js'
import { ForgotPassword } from '../pages/ForgotPassword.js'
import { ResetPassword } from '../pages/ResetPassword.js'
import { I18nProvider, useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { RouterProvider, useRouter, Link, Navigate } from '../router/router.js'
import { AuthProvider, useAuth } from '../auth/AuthContext.js'
import { AccountMenu } from './AccountMenu.js'

/** API base: same-origin in prod (fastify-static serves the FE); override via env in dev. */
const BASE = (import.meta.env?.VITE_API_BASE as string | undefined) ?? ''

function Brand() {
  const { t } = useI18n()
  return (
    <Link to="/" className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
      <AkisLogo size={34} alt="" className="drop-shadow-[0_0_16px_rgba(7,209,175,0.5)]" />
      {/* The logo is decorative (alt="") to avoid a double "AKIS … AKIS" announce next to the
          wordmark. The wordmark itself is shown on EVERY viewport — a compact "AKIS" on mobile
          (so the brand isn't a bare glyph next to the DEMO badge) and the full title from sm —
          so the visible text always names the home link with no sr-only fallback needed. */}
      <span className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-base font-extrabold leading-tight text-transparent">
        <span className="sm:hidden">AKIS</span>
        <span className="hidden sm:inline">{t('app.title')}</span>
      </span>
    </Link>
  )
}

function NavLink({ to, label }: { to: string; label: string }) {
  const { path } = useRouter()
  const active = path === to
  return (
    // aria-current="page" marks the active route for AT — only when active (conditional spread:
    // exactOptionalPropertyTypes forbids passing the attribute as undefined).
    <Link to={to} {...(active ? { ariaCurrent: 'page' as const } : {})} className={`shrink-0 rounded-lg px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${active ? 'bg-white/10 text-slate-100' : 'text-slate-300 hover:text-slate-100'}`}>{label}</Link>
  )
}

/**
 * B1 — unmissable DEMO badge. Reads GET /health once on load; when the server reports
 * `mode:'demo'` (the mock provider and/or mock verification is active, so "verified" output
 * is NOT from real tests) it renders a small amber/warning badge in the studio header.
 * Renders nothing for a `live` boot (or if /health can't be reached).
 */
export function DemoBadge({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const [demo, setDemo] = useState(false)
  useEffect(() => { void api.health().then(h => setDemo(h.mode === 'demo')).catch(() => {}) }, [api])
  if (!demo) return null
  return (
    <span role="status" title={t('mode.demo.title')}
      className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-300 shadow-[0_0_12px_rgba(251,191,36,0.25)]">
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
      {t('mode.demo.badge')}
    </span>
  )
}

// Map an authed route → the i18n key for its human title. Reuses the existing nav.* labels
// (they already name every route + carry full TR/EN parity), so the document.title and the
// per-view <h1> stay localized and in sync with the nav. Unknown paths fall back to the app name.
const ROUTE_TITLE_KEY: Record<string, StringKey> = {
  '/': 'nav.dashboard',
  '/history': 'nav.history',
  '/analytics': 'nav.analytics',
  '/workflows': 'nav.workflows',
  '/settings': 'nav.settings',
  '/docs': 'nav.docs',
}

/** The authenticated app frame: cosmic backdrop, top nav, and the routed page. */
function AppFrame({ api }: { api: ApiClient }) {
  const { t, locale, setLocale } = useI18n()
  const { path } = useRouter()
  const { user, logout } = useAuth()

  // The localized title for the current route (falls back to the app name for an unknown path).
  const routeTitleKey = ROUTE_TITLE_KEY[path]
  const routeTitle = routeTitleKey ? t(routeTitleKey) : t('app.title')

  // Per-route document.title so browser tabs / history / bookmarks name the view (mirrors the
  // <html lang> sync in I18nContext: guarded for SSR, re-runs on locale change for the right tongue).
  useEffect(() => {
    if (typeof document !== 'undefined') document.title = `${routeTitle} · AKIS`
    // routeTitle already folds in path + locale; list both so intent is explicit.
  }, [path, locale, routeTitle])

  const page = path === '/analytics' ? <AnalyticsPage api={api} />
    : path === '/history' ? <HistoryPage api={api} />
    : path === '/workflows' ? <WorkflowsPage api={api} />
    : path === '/settings' ? <SettingsPage api={api} />
    : path === '/docs' ? <DocsPage />
    : path === '/' ? <ChatStudio api={api} baseUrl={BASE} />
    : <Navigate to="/" />

  // ROUTE-AWARE FRAME WIDTH (live UX feedback): the studio is a WORKSPACE (chat + live preview
  // side by side) — capping it at max-w-6xl left huge dead margins on wide screens and squeezed
  // the preview. It now breathes up to 120rem; the content pages (docs/history/settings…) keep
  // the comfortable reading cap they were designed for.
  const isStudio = path === '/'

  return (
    <div className="relative min-h-screen text-slate-100">
      <CosmicBackground />
      {/* Skip link: the FIRST focusable element in the frame so keyboard/AT users can jump past
          the nav straight to the routed content. Visually hidden until focused (sr-only →
          focus:not-sr-only), then pinned top-left with the shared teal focus ring. */}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-slate-900 focus:px-4 focus:py-2 focus:text-sm focus:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/60 focus:ring-offset-2 focus:ring-offset-slate-950">{t('a11y.skipToContent')}</a>
      <div className={`relative z-10 mx-auto px-4 py-6 sm:px-6 ${isStudio ? 'max-w-[120rem] lg:px-8 2xl:px-10' : 'max-w-6xl'}`}>
        {/* One visually-hidden <h1> per authed view: the on-page SectionTitle is an <h2> (and is
            reused as a sub-heading inside Analytics), so this gives each view a single, unique,
            route-named top-level heading for AT heading navigation without altering the visuals. */}
        <h1 className="sr-only">{routeTitle}</h1>
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <Brand />
          {/* Mobile: a single horizontally-scrollable row (shrink-0 NavLinks + whitespace-nowrap)
              instead of a wrapping multi-row pile — scales to longer TR labels without reflow and
              keeps the header to two tidy rows. The thin scrollbar is hidden. From sm it's the
              normal inline bar. */}
          <nav aria-label={t('nav.primary')} className="order-3 -mx-1 flex w-full items-center gap-1 overflow-x-auto whitespace-nowrap px-1 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:py-0 sm:px-0">
            <NavLink to="/" label={t('nav.dashboard')} />
            <NavLink to="/history" label={t('nav.history')} />
            <NavLink to="/analytics" label={t('nav.analytics')} />
            <NavLink to="/workflows" label={t('nav.workflows')} />
            <NavLink to="/settings" label={t('nav.settings')} />
            <NavLink to="/docs" label={t('nav.docs')} />
          </nav>
          <div className="flex items-center gap-2">
            <DemoBadge api={api} />
            <button onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')} aria-label={t('nav.toggleLanguage')}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-slate-300 transition hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">{locale.toUpperCase()}</button>
            <div className="hidden text-right sm:block">
              <div className="text-xs font-medium text-slate-200">{user?.name}</div>
            </div>
            {user && <AccountMenu user={user} logout={logout} />}
          </div>
        </header>
        <main id="main">
          <Suspense fallback={<PageFallback />}>{page}</Suspense>
        </main>
      </div>
    </div>
  )
}

/** Cosmic frame for the public auth pages. */
function PublicFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="relative min-h-screen text-slate-100">
      <CosmicBackground />
      {/* Same skip link + <main> landmark as the authed frame, so keyboard/AT users on the public
          pages (Landing/Login/Docs — these already carry their own <h1>) can jump to content. */}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-slate-900 focus:px-4 focus:py-2 focus:text-sm focus:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#07D1AF]/60 focus:ring-offset-2 focus:ring-offset-slate-950">{t('a11y.skipToContent')}</a>
      <main id="main" className="relative z-10">{children}</main>
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

/** Public Docs view (anon) — a minimal branded header over the shared DocsPage. */
function PublicDocs() {
  const { t } = useI18n()
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-8 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
          <AkisLogo size={30} alt="" className="drop-shadow-[0_0_14px_rgba(7,209,175,0.5)]" />
          <span className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-sm font-extrabold text-transparent">{t('app.title')}</span>
        </Link>
        <Link to="/login" className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-sm text-slate-200 hover:border-white/20">{t('landing.cta.signin')}</Link>
      </header>
      <Suspense fallback={<PageFallback />}><DocsPage /></Suspense>
    </div>
  )
}

/** Lightweight in-frame fallback for a lazy route chunk (the page frame is already painted). */
function PageFallback() {
  const { t } = useI18n()
  return (
    <div className="grid min-h-[40vh] place-items-center">
      <div className="flex items-center gap-3 text-slate-400">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-[#07D1AF]/40 border-t-[#07D1AF]" />{t('common.loading')}
      </div>
    </div>
  )
}

function Shell({ api }: { api: ApiClient }) {
  const { user, loading, clear } = useAuth()
  const { path, navigate } = useRouter()
  // On a 401 from any authenticated request (expired/revoked cookie), drop the cached user
  // and route to sign-in — so a stale session can never leave the user stuck mid-app.
  useEffect(() => {
    api.onUnauthorized = () => { clear(); navigate('/login') }
    return () => { api.onUnauthorized = undefined }
  }, [api, clear, navigate])
  if (loading) return <Loader />
  if (path === '/login') return user ? <Navigate to="/" /> : <PublicFrame><Login api={api} /></PublicFrame>
  if (path === '/signup') return user ? <Navigate to="/" /> : <PublicFrame><Signup api={api} /></PublicFrame>
  // Reset works in either auth state (the link arrives by email/out-of-band).
  if (path === '/forgot-password') return <PublicFrame><ForgotPassword api={api} /></PublicFrame>
  if (path === '/reset-password') return <PublicFrame><ResetPassword api={api} /></PublicFrame>
  if (!user) return <PublicFrame>{path === '/docs' ? <PublicDocs /> : <Landing />}</PublicFrame>
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
