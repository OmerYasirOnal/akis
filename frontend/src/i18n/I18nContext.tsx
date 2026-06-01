import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'
import { STRINGS, type Locale, type StringKey } from './catalog.js'

interface I18n { locale: Locale; setLocale: (l: Locale) => void; t: (k: StringKey) => string }

const I18nCtx = createContext<I18n | null>(null)

/** Feature-sliced i18n via context (no prop-drilling, F2-AC11). */
export function I18nProvider({ children, initial = 'en' }: { children: ReactNode; initial?: Locale }) {
  const [locale, setLocale] = useState<Locale>(initial)
  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (k: StringKey) => STRINGS[locale][k] ?? STRINGS.en[k] ?? k }), [locale])
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>
}

export function useI18n(): I18n {
  const ctx = useContext(I18nCtx)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}
