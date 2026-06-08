import { useState, type FormEvent } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useAuth } from '../auth/AuthContext.js'
import { useRouter, Link } from '../router/router.js'
import { Button, Field, ErrorNote } from '../ui/kit.js'
import { PasswordInput } from '../ui/PasswordInput.js'
import { useI18n } from '../i18n/I18nContext.js'
import { AuthShell } from './AuthShell.js'

export function ResetPassword({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const { navigate } = useRouter()
  const { refresh } = useAuth()
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (password.length < 8) { setErr(t('auth.pwTooShort')); return }
    setBusy(true); setErr(undefined)
    try {
      await api.resetPassword(token, password)
      await refresh()      // reset sets a fresh session cookie → reflect it in the SPA
      navigate('/')
    } catch (e) { setErr(ApiError.is(e) ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  if (!token) {
    return (
      <AuthShell title={t('auth.reset.title')}
        footer={<Link to="/forgot-password" className="font-semibold text-[#07D1AF] hover:underline">{t('auth.forgot.title')}</Link>}>
        <ErrorNote>{t('auth.reset.noToken')}</ErrorNote>
      </AuthShell>
    )
  }

  return (
    <AuthShell title={t('auth.reset.title')} subtitle={t('auth.reset.subtitle')}
      footer={<Link to="/login" className="font-semibold text-[#07D1AF] hover:underline">{t('auth.back')}</Link>}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t('auth.password')} hint={t('auth.pwHint')}>
          <PasswordInput autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" required />
        </Field>
        {err && <ErrorNote>{err}</ErrorNote>}
        <Button type="submit" full loading={busy} disabled={password.length < 8}>{t('auth.reset.cta')}</Button>
      </form>
    </AuthShell>
  )
}
