import { useState, useEffect, type FormEvent } from 'react'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { useAuth } from '../auth/AuthContext.js'
import { SectionTitle, Button, Field, Input, ErrorNote } from '../ui/kit.js'
import { useI18n } from '../i18n/I18nContext.js'

/** Account self-management: edit display name + change password. Uses AuthContext so a
 *  name change reflects immediately in the header; password change is verified server-side. */
export function AccountSettings({ api }: { api: ApiClient }) {
  const { t } = useI18n()
  const { user, refresh } = useAuth()
  const [name, setName] = useState(user?.name ?? '')
  // The session (and thus user.name) resolves async after mount — populate the field
  // once it arrives (and after a save refreshes it). Keystrokes don't change user.name.
  useEffect(() => { setName(user?.name ?? '') }, [user?.name])
  const [savingName, setSavingName] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameErr, setNameErr] = useState<string | undefined>()

  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [savingPw, setSavingPw] = useState(false)
  const [pwDone, setPwDone] = useState(false)
  const [pwErr, setPwErr] = useState<string | undefined>()

  const saveName = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!name.trim()) return
    setSavingName(true); setNameErr(undefined); setNameSaved(false)
    try { await api.updateProfile(name.trim()); await refresh(); setNameSaved(true) }
    catch (err) { setNameErr(ApiError.is(err) ? err.message : String(err)) }
    finally { setSavingName(false) }
  }
  const changePw = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (next.length < 8) { setPwErr(t('auth.pwTooShort')); return }
    setSavingPw(true); setPwErr(undefined); setPwDone(false)
    try { await api.changePassword(cur, next); setCur(''); setNext(''); setPwDone(true) }
    catch (err) { setPwErr(ApiError.is(err) ? err.message : String(err)) }
    finally { setSavingPw(false) }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2 md:gap-8">
      <form onSubmit={saveName} className="flex flex-col gap-3">
        <SectionTitle>{t('settings.profile.title')}</SectionTitle>
        <div className="text-sm text-slate-400">{user?.email}</div>
        <Field label={t('settings.profile.name')}>
          <Input value={name} onChange={e => { setName(e.target.value); setNameSaved(false) }} />
        </Field>
        {nameErr && <ErrorNote>{nameErr}</ErrorNote>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={savingName || !name.trim() || name.trim() === user?.name}>{t('settings.profile.save')}</Button>
          {nameSaved && <span className="text-xs text-[#07D1AF]">{t('settings.profile.saved')}</span>}
        </div>
      </form>

      {/* A divider so "Profile" and "Change password" read as two distinct concerns: a top
          border on mobile (stacked) and a left border on md+ (side-by-side columns). */}
      <form onSubmit={changePw} className="flex flex-col gap-3 border-t border-white/10 pt-6 md:border-l md:border-t-0 md:pl-8 md:pt-0">
        <SectionTitle>{t('settings.password.title')}</SectionTitle>
        <Field label={t('settings.password.current')} hint={t('settings.password.currentHint')}>
          <Input type="password" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
        </Field>
        <Field label={t('settings.password.new')} hint={t('auth.pwHint')}>
          <Input type="password" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
        </Field>
        {pwErr && <ErrorNote>{pwErr}</ErrorNote>}
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={savingPw || next.length < 8}>{t('settings.password.change')}</Button>
          {pwDone && <span className="text-xs text-[#07D1AF]">{t('settings.password.changed')}</span>}
        </div>
      </form>
    </div>
  )
}
