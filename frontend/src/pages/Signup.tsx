import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext.js'
import { useRouter, Link } from '../router/router.js'
import { ApiClient, ApiError } from '../api/client.js'
import { Button, Field, Input, ErrorNote } from '../ui/kit.js'
import { PasswordInput } from '../ui/PasswordInput.js'
import { useI18n } from '../i18n/I18nContext.js'
import { AuthShell } from './AuthShell.js'
import { OAuthButtons } from './OAuthButtons.js'

export function Signup({ api }: { api: ApiClient }) {
  const { signup } = useAuth()
  const { navigate } = useRouter()
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (password.length < 8) { setErr(t('auth.pwTooShort')); return }
    setBusy(true); setErr(undefined)
    try { await signup(name, email, password); navigate('/') }
    // A 403 is the intentional signup block (this is a single-user instance — the edge/code both
    // 403 /auth/signup). Show a clear, localized message instead of the raw "HTTP 403".
    catch (e) { setErr(ApiError.is(e) && e.status === 403 ? t('auth.signup.disabled') : ApiError.is(e) ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <AuthShell title={t('auth.signup.title')} subtitle={t('auth.signup.subtitle')}
      footer={<>{t('auth.haveAccount')} <Link to="/login" className="font-semibold text-[#07D1AF] hover:underline">{t('auth.login.cta')}</Link></>}>
      <div className="mb-4"><OAuthButtons api={api} /></div>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.name')}>
          <Input autoComplete="name" value={name} onChange={e => setName(e.target.value)} placeholder="Ada Lovelace" required />
        </Field>
        <Field label={t('auth.email')}>
          <Input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.pwHint')}>
          <PasswordInput autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button type="submit" full disabled={busy || !name || !email || password.length < 8}>{busy ? '…' : t('auth.signup.cta')}</Button>
      </form>
    </AuthShell>
  )
}
