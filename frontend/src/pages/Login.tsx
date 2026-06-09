import { useState, useMemo, type FormEvent } from 'react'
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
  // OAuth callback errors (?error=<code>) render UP by the OAuth buttons that caused them; form
  // submit errors render DOWN in the form. Separating them stops an OAuth failure from looking
  // like an email/password error at the bottom of the card. Known codes map to a specific message;
  // an unrecognized/empty code still shows the generic auth.oauth.error (never a raw code).
  const oauthErr = useMemo(() => {
    const code = new URLSearchParams(window.location.search).get('error')
    return code ? t(OAUTH_ERROR_KEYS[code] ?? 'auth.oauth.error') : undefined
  }, [t])
  const [err, setErr] = useState<string | undefined>()

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
      <div className="mb-4 flex flex-col gap-3">
        {oauthErr && <ErrorNote>{oauthErr}</ErrorNote>}
        <OAuthButtons api={api} />
      </div>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.email')}>
          <Input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label={t('auth.password')}>
          <PasswordInput autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required />
        </Field>
        <Link to="/forgot-password" className="self-end py-1 text-sm text-slate-400 transition hover:text-[#07D1AF]">{t('auth.forgot.link')}</Link>
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button type="submit" full loading={busy} disabled={!email || !password}>{t('auth.login.cta')}</Button>
      </form>
    </AuthShell>
  )
}
