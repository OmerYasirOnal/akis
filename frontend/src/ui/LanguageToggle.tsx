import { useI18n } from '../i18n/I18nContext.js'

/** A globe glyph so the EN/TR control reads as a LANGUAGE switch, not a bare label. */
function GlobeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><path d="M2 12h20" /><path d="M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20Z" />
    </svg>
  )
}

/** EN/TR language toggle — shared by the authed header AND the auth pages (AuthShell), so a
 *  visitor can switch locale before signing in. The globe glyph + aria-label make it legible
 *  as a language control; the label shows the current locale. */
export function LanguageToggle() {
  const { t, locale, setLocale } = useI18n()
  return (
    <button onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')} aria-label={t('nav.toggleLanguage')}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-slate-300 transition hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#07D1AF]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950">
      <GlobeIcon /> {locale.toUpperCase()}
    </button>
  )
}
