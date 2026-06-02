import { useState, type FormEvent } from 'react'
import { ApiClient, ApiError } from '../api/client.js'
import { useRouter, Link } from '../router/router.js'
import { Button, Field, Input, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'
import { AuthShell } from './AuthShell.js'

export function ForgotPassword({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const { navigate } = useRouter()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [devUrl, setDevUrl] = useState<string | undefined>()
  const [err, setErr] = useState<string | undefined>()

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true); setErr(undefined)
    try {
      const r = await api.forgotPassword(email)
      setSent(true)
      if (r.resetUrl) setDevUrl(r.resetUrl) // dev-only echo (no email service)
    } catch (e) { setErr(ApiError.is(e) ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <AuthShell title={t('auth.forgot.title')} subtitle={t('auth.forgot.subtitle')}
      footer={<Link to="/login" className="font-semibold text-[#07D1AF] hover:underline">{t('auth.back')}</Link>}>
      {sent ? (
        <div className="flex flex-col gap-3 text-sm text-slate-200">
          <p>{t('auth.forgot.sent')}</p>
          {devUrl && <button onClick={() => navigate(devUrl)} className="self-start font-semibold text-[#07D1AF] hover:underline">{t('auth.forgot.devLink')}</button>}
        </div>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <Field label={t('auth.email')}>
            <Input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required />
          </Field>
          {err && <ErrorNote>{err}</ErrorNote>}
          <Button type="submit" full disabled={busy || !email}>{busy ? '…' : t('auth.forgot.cta')}</Button>
        </form>
      )}
    </AuthShell>
  )
}
