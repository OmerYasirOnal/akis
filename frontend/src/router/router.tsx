import { createContext, useCallback, useContext, useEffect, useState, type ReactNode, type MouseEvent } from 'react'

interface RouterValue { path: string; navigate: (to: string, opts?: { replace?: boolean }) => void }
const RouterCtx = createContext<RouterValue | null>(null)

/** A tiny History-API router (no dependency). Holds the current pathname and exposes
 *  navigate(); components switch on `useRouter().path`. Good enough for a fixed set of
 *  top-level pages and fully testable under jsdom. */
export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname || '/')
  useEffect(() => {
    const onPop = (): void => setPath(window.location.pathname || '/')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = useCallback((to: string, opts?: { replace?: boolean }) => {
    // `to` may carry a query string (e.g. /reset-password?token=…). Push the FULL url
    // (so location.search is populated) but track only the pathname for route matching.
    const pathname = new URL(to, window.location.origin).pathname
    if (pathname === window.location.pathname && to === window.location.pathname + window.location.search) return
    if (opts?.replace) window.history.replaceState({}, '', to)
    else window.history.pushState({}, '', to)
    setPath(pathname)
  }, [])
  return <RouterCtx.Provider value={{ path, navigate }}>{children}</RouterCtx.Provider>
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterCtx)
  if (!ctx) throw new Error('useRouter must be used within RouterProvider')
  return ctx
}

/** An <a> that navigates client-side (honoring modifier-clicks / new-tab). */
export function Link({ to, className, children, onClick }: { to: string; className?: string; children: ReactNode; onClick?: () => void }) {
  const { navigate } = useRouter()
  const handle = (e: MouseEvent): void => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault(); onClick?.(); navigate(to)
  }
  return <a href={to} onClick={handle} {...(className ? { className } : {})}>{children}</a>
}

/** Imperative redirect: renders nothing, navigates (replace) on mount. */
export function Navigate({ to }: { to: string }) {
  const { navigate } = useRouter()
  useEffect(() => { navigate(to, { replace: true }) }, [to, navigate])
  return null
}
