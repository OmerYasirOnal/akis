import type { SameSite } from '../auth/cookie.js'

/**
 * CSRF posture check (pure). The session cookie's SameSite is the PRIMARY CSRF defence: Lax/Strict
 * mean the browser never sends it on a cross-site state-changing request, so a forged POST carries
 * no session. The Origin-check hook (server.ts) is defence-in-depth, effective only when a trusted
 * origin (PUBLIC_BASE_URL) is configured.
 *
 * The ONE genuinely-unprotected combination is SameSite=None (an explicit opt-in for cross-site
 * embedding — no SameSite protection) together with NO trusted origin (no Origin check). Returns a
 * warning string for exactly that combo, else undefined. This never changes request behavior — it
 * only lets the operator KNOW their state-changing routes have no CSRF guard in that config.
 */
export function csrfPostureWarning(sameSite: SameSite, trustedOrigin: string | undefined): string | undefined {
  if (sameSite === 'none' && !trustedOrigin) {
    return 'CSRF: the session cookie is SameSite=None but PUBLIC_BASE_URL is unset — state-changing routes have NO CSRF guard (no SameSite protection AND no Origin check). Set PUBLIC_BASE_URL to enable the Origin check, or use SameSite=Lax/Strict.'
  }
  return undefined
}
