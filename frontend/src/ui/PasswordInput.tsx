import { useState, type InputHTMLAttributes } from 'react'
import { useI18n } from '../i18n/I18nContext.js'
import { Input } from './kit.js'

/** Eye / eye-off glyphs for the reveal toggle (decorative; the button carries the label). */
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2 2 20 20" /><path d="M6.7 6.7C4 8.3 2 12 2 12s3.5 7 10 7c2 0 3.7-.5 5.2-1.3" /><path d="M9.9 4.2A10.9 10.9 0 0 1 12 4c6.5 0 10 7 10 7a18 18 0 0 1-2.3 3.3" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </svg>
  )
}

/** A password field with a show/hide reveal toggle — the baseline expectation on a credible
 *  auth screen (lets a user verify a new password they're choosing). Reuses the kit `Input`
 *  (so it inherits the shared surface + focus ring), and the toggle flips the input `type`
 *  while announcing its state (`aria-pressed` + a localized `aria-label`). `type` is owned
 *  by the toggle, so callers pass everything EXCEPT `type`. */
export function PasswordInput({ className = '', ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const { t } = useI18n()
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input type={show ? 'text' : 'password'} className={`pr-11 ${className}`} {...rest} />
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        aria-pressed={show}
        aria-label={show ? t('auth.password.hide') : t('auth.password.show')}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-xl text-slate-400 transition hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
      >
        {show ? <EyeOffIcon /> : <EyeIcon />}
      </button>
    </div>
  )
}
