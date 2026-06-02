import { useI18n } from '../i18n/I18nContext.js'
import { Link, useRouter } from '../router/router.js'
import { AkisLogo } from '../components/AkisLogo.js'
import { Card, Button } from '../ui/kit.js'

const STEPS = ['1', '2', '3', '4'] as const
const FEATURES = ['providers', 'gates', 'preview', 'selfhost', 'agents', 'analytics'] as const

/** Public marketing landing (anon at /). Cosmic, brand-teal, with the real AKIS mark;
 *  hero → how-it-works → features → CTA. Authed users get the studio instead. */
export function Landing() {
  const { t, locale, setLocale } = useI18n()
  const { navigate } = useRouter()
  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      {/* Public nav */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AkisLogo size={34} alt="" className="drop-shadow-[0_0_16px_rgba(7,209,175,0.5)]" />
          <span className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-base font-extrabold text-transparent">{t('app.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')} aria-label={t('nav.toggleLanguage')} className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-slate-300 hover:border-white/20">{locale.toUpperCase()}</button>
          <Link to="/docs" className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:text-slate-100">{t('nav.docs')}</Link>
          <Link to="/login" className="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:text-slate-100">{t('landing.cta.signin')}</Link>
          <Button onClick={() => navigate('/signup')}>{t('landing.cta.start')}</Button>
        </div>
      </header>

      {/* Hero */}
      <section className="flex flex-col items-center py-20 text-center sm:py-28">
        <AkisLogo size={84} className="mb-6 drop-shadow-[0_0_40px_rgba(7,209,175,0.55)]" />
        <div className="mb-3 text-xs uppercase tracking-[0.3em] text-[#07D1AF]">{t('landing.tagline')}</div>
        <h1 className="max-w-3xl bg-gradient-to-r from-white via-cyan-100 to-violet-200 bg-clip-text text-4xl font-extrabold leading-tight text-transparent sm:text-5xl">{t('landing.headline')}</h1>
        <p className="mt-5 max-w-2xl text-base text-slate-300 sm:text-lg">{t('landing.sub')}</p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button onClick={() => navigate('/signup')} className="px-6 py-3 text-base">{t('landing.cta.start')}</Button>
          <Button variant="ghost" onClick={() => navigate('/docs')} className="px-6 py-3 text-base">{t('landing.cta.docs')}</Button>
        </div>
      </section>

      {/* How it works */}
      <section className="py-10">
        <h2 className="mb-8 text-center text-2xl font-bold text-slate-100">{t('landing.how.title')}</h2>
        <div className="grid gap-4 md:grid-cols-4">
          {STEPS.map((s, i) => (
            <Card key={s} className="p-5">
              <div className="mb-2 grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-sm font-black text-slate-950">{i + 1}</div>
              <h3 className="font-semibold text-slate-100">{t(`landing.how.${s}.t`)}</h3>
              <p className="mt-1 text-sm text-slate-400">{t(`landing.how.${s}.d`)}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="py-10">
        <h2 className="mb-8 text-center text-2xl font-bold text-slate-100">{t('landing.features.title')}</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(f => (
            <Card key={f} glow className="p-5">
              <h3 className="mb-1 font-semibold text-[#07D1AF]">{t(`landing.feat.${f}.t`)}</h3>
              <p className="text-sm leading-relaxed text-slate-300">{t(`landing.feat.${f}.d`)}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* CTA + footer */}
      <section className="flex flex-col items-center gap-4 py-16 text-center">
        <h2 className="text-2xl font-bold text-slate-100">{t('landing.headline')}</h2>
        <Button onClick={() => navigate('/signup')} className="px-6 py-3 text-base">{t('landing.cta.start')}</Button>
      </section>
      <footer className="border-t border-white/10 py-8 text-center text-xs text-slate-400">{t('landing.footer')}</footer>
    </div>
  )
}
