import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ApiClient, AuthUser } from '../api/client.js'
import { clearAllThreads } from '../chat/akisThread.js'

interface AuthValue {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (name: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-fetch the session (e.g. after a password reset that set a fresh cookie). */
  refresh: () => Promise<void>
  /** Clear the cached user locally WITHOUT a server call — used when a 401 tells us the
   *  cookie already expired/was revoked, so there is nothing to log out server-side. */
  clear: () => void
}
const AuthCtx = createContext<AuthValue | null>(null)

/** Holds auth state. Restores the session once on mount via GET /auth/me (the httpOnly
 *  cookie rides along), then exposes login/signup/logout that update the cached user. */
export function AuthProvider({ api, children }: { api: ApiClient; children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    api.me()
      .then(r => { if (active) setUser(r.user) })
      .catch(() => { if (active) setUser(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [api])

  // SIGN-IN ALSO SWEEPS (gate-keeper LOW): if the previous user closed the browser without logging
  // out (no logout/401 ever ran), their persisted spines would survive into the NEXT account's
  // session on this machine. Display-only chat text — no token/capability — but still another
  // user's conversation, so a fresh sign-in/sign-up starts from a clean slate.
  const login = async (email: string, password: string): Promise<void> => { const u = (await api.login(email, password)).user; clearAllThreads(); setUser(u) }
  const signup = async (name: string, email: string, password: string): Promise<void> => { const u = (await api.signup({ name, email, password })).user; clearAllThreads(); setUser(u) }
  // Clear local state even if the network/server call fails — never leave a user
  // looking signed-in after a logout attempt.
  const logout = async (): Promise<void> => { try { await api.logout() } finally { clearAllThreads(); setUser(null) } }
  const refresh = async (): Promise<void> => { try { setUser((await api.me()).user) } catch { setUser(null) } }
  // Clearing the user (explicit logout OR a 401-expiry) ALSO drops EVERY persisted AKIS chat spine
  // (the draft + every per-build anchor), so a DIFFERENT user signing in on this browser can never
  // see a prior conversation — per-conversation keying means there's no longer one key to remove.
  const clear = (): void => { clearAllThreads(); setUser(null) }

  return <AuthCtx.Provider value={{ user, loading, login, signup, logout, refresh, clear }}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
