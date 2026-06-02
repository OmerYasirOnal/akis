import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext.js'
import { useRouter, Link } from '../router/router.js'
import { ApiError } from '../api/client.js'
import { Button, Field, Input, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { AuthShell } from './AuthShell.js'

export function Login() {
  const { login } = useAuth()
  const { navigate } = useRouter()
  const { t } = useI18n()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
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
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.email')}>
          <Input type="email" autoComplete="email" aria-label="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
        </Field>
        <Field label={t('auth.password')}>
          <Input type="password" autoComplete="current-password" aria-label="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button type="submit" full disabled={busy || !email || !password}>{busy ? '…' : t('auth.login.cta')}</Button>
      </form>
    </AuthShell>
  )
}
