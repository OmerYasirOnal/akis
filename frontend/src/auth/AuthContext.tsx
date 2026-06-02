import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { ApiClient, AuthUser } from '../api/client.js'

interface AuthValue {
  user: AuthUser | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  signup: (name: string, email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** Re-fetch the session (e.g. after a password reset that set a fresh cookie). */
  refresh: () => Promise<void>
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

  const login = async (email: string, password: string): Promise<void> => { setUser((await api.login(email, password)).user) }
  const signup = async (name: string, email: string, password: string): Promise<void> => { setUser((await api.signup({ name, email, password })).user) }
  // Clear local state even if the network/server call fails — never leave a user
  // looking signed-in after a logout attempt.
  const logout = async (): Promise<void> => { try { await api.logout() } finally { setUser(null) } }
  const refresh = async (): Promise<void> => { try { setUser((await api.me()).user) } catch { setUser(null) } }

  return <AuthCtx.Provider value={{ user, loading, login, signup, logout, refresh }}>{children}</AuthCtx.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
