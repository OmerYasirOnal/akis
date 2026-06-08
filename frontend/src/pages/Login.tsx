import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext.js'
import { useRouter, Link } from '../router/router.js'
import { ApiClient, ApiError } from '../api/client.js'
import { Button, Field, Input, ErrorNote } from '../ui/kit.js'
import { PasswordInput } from '../ui/PasswordInput.js'
import { useI18n } from '../i18n/I18nContext.js'
import { AuthShell } from './AuthShell.js'
import { OAuthButtons } from './OAuthButtons.js'
import type { StringKey } from '../i18n/catalog.js'

/** Map the OAuth callback's ?error=<code> to a specific message key. An unrecognized/empty code
 *  falls through to the generic auth.oauth.error — so the page never shows a raw code. */
const OAUTH_ERROR_KEYS: Record<string, StringKey> = {
  oauth_denied: 'auth.oauth.err.denied',
  oauth_unavailable: 'auth.oauth.err.unavailable',
  oauth_state: 'auth.oauth.err.state',
  oauth_failed: 'auth.oauth.err.failed',
  oauth_unknown: 'auth.oauth.err.unknown',
}

export function Login({ api }: { api: ApiClient }) {
  const { login } = useAuth()
  const { navigate } = useRouter()
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Surface an OAuth callback error passed back as ?error=<code>. Known codes map to a specific
  // message; an unrecognized/empty code still shows the generic auth.oauth.error.
  const [err, setErr] = useState<string | undefined>(() => {
    const code = new URLSearchParams(window.location.search).get('error')
    if (!code) return undefined
    return t(OAUTH_ERROR_KEYS[code] ?? 'auth.oauth.error')
  })

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    try { await login(email, password); navigate('/') }
    catch (e) { setErr(ApiError.is(e) ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <AuthShell title={t('auth.login.title')} subtitle={t('auth.login.subtitle')}
      footer={<>{t('auth.noAccount')} <Link to="/signup" className="font-semibold text-[#07D1AF] hover:underline">{t('auth.signup.cta')}</Link></>}>
      <div className="mb-4"><OAuthButtons api={api} /></div>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.email')}>
          <Input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label={t('auth.password')}>
          <PasswordInput autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        <Link to="/forgot-password" className="-mt-2 self-end text-xs text-slate-400 hover:text-[#07D1AF]">{t('auth.forgot.link')}</Link>
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button type="submit" full loading={busy} disabled={!email || !password}>{t('auth.login.cta')}</Button>
      </form>
    </AuthShell>
  )
}
