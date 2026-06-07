import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { STRINGS, type Locale, type StringKey } from './catalog.js'

interface I18n { locale: Locale; setLocale: (l: Locale) => void; t: (k: StringKey) => string }

const I18nCtx = createContext<I18n | null>(null)

/** localStorage key holding the user's language choice across navigations/reloads. */
const LANG_KEY = 'akis_lang'

/** Resolve localStorage defensively — undefined in SSR and some privacy modes (where even
 *  *accessing* it throws), so callers degrade to in-memory-only locale rather than crash. */
function langStore(): Storage | undefined {
  try { return typeof localStorage !== 'undefined' ? localStorage : undefined } catch { return undefined }
}

function isLocale(v: unknown): v is Locale { return v === 'en' || v === 'tr' }

/** Read the persisted locale; malformed/unknown values are ignored so we fall back to `initial`. */
function loadLocale(initial: Locale): Locale {
  try { const v = langStore()?.getItem(LANG_KEY); return isLocale(v) ? v : initial } catch { return initial }
}

/** Feature-sliced i18n via context (no prop-drilling, F2-AC11). The chosen locale is persisted
 *  to localStorage and read on init, so TR survives navigation and reload (it was previously
 *  in-memory React state that reverted to EN on every page change).
 *  NOTE: a persisted choice WINS over the `initial` prop — `initial` is only the fallback when
 *  nothing (valid) is persisted. A future `<I18nProvider initial="tr">` cannot force a locale
 *  past a stored `akis_lang`; clear the key if you ever need that. */
export function I18nProvider({ children, initial = 'en' }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocaleState] = useState<Locale>(() => loadLocale(initial))
  // Keep <html lang> in sync so screen readers pronounce TR/EN content correctly (WCAG 3.1.2).
  useEffect(() => { if (typeof document !== 'undefined') document.documentElement.lang = locale }, [locale])
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    try { langStore()?.setItem(LANG_KEY, l) } catch { /* non-fatal: degrade to in-memory only */ }
  }, [])
  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (k: StringKey) => STRINGS[locale][k] ?? STRINGS.en[k] ?? k }), [locale, setLocale])
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nCtx)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
