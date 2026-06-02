import { useI18n } from '../i18n/I18nContext.js'
import { Link, useRouter } from '../router/router.js'
import { AkisLogo } from '../components/AkisLogo.js'
import { Card, Button } from '../ui/kit.js'

const STEPS = ['1', '2', '3', '4'] as const
const FEATURE_KEYS = ['providers', 'gates', 'preview', 'selfhost', 'agents', 'analytics'] as const

const CHAIN = [
  { agent: 'Scribe', action: 'Idea → spec', state: 'approved' },
  { agent: 'Proto', action: 'Spec → code', state: 'built' },
  { agent: 'Trace', action: 'Real tests', state: '312 passed' },
  { agent: 'Critic', action: 'Quality review', state: 'clear' },
  { agent: 'Push gate', action: 'Human confirm', state: 'ready' },
] as const

const TRUST_SIGNALS = ['providers', 'gates', 'selfhost'] as const

/**
 * Public marketing landing (anon at /).
 *
 * Design intent:
 * - premium, minimal SaaS surface instead of a heavy sci-fi poster;
 * - three-color AKIS system: ink, verified mint, electric cyan;
 * - animated but calm: orbiting verification mark, scan line, chain progress;
 * - product truth first: provider-agnostic, real tests, self-hostable, human-gated.
 */
export function Landing() {
  const { t, locale, setLocale } = useI18n()
  const { navigate } = useRouter()

  return (
    <div className="relative mx-auto max-w-7xl overflow-hidden px-4 py-6 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute left-1/2 top-12 h-80 w-80 -translate-x-1/2 rounded-full bg-[#2EE6A6]/10 blur-3xl" />
      <div className="pointer-events-none absolute right-0 top-48 h-96 w-96 rounded-full bg-[#22D3EE]/10 blur-3xl" />

      {/* Public nav */}
      <header className="relative z-20 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <AkisLogo size={34} alt="" className="drop-shadow-[0_0_18px_rgba(46,230,166,0.42)]" />
          <span className="text-sm font-extrabold tracking-[0.32em] text-slate-100">AKIS</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')}
            aria-label={t('nav.toggleLanguage')}
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-[#2EE6A6]/40 hover:text-slate-100"
          >
            {locale.toUpperCase()}
          </button>
          <Link to="/docs" className="rounded-full px-3 py-1.5 text-sm text-slate-300 transition hover:text-slate-100">{t('nav.docs')}</Link>
          <Link to="/login" className="rounded-full px-3 py-1.5 text-sm text-slate-300 transition hover:text-slate-100">{t('landing.cta.signin')}</Link>
          <Button onClick={() => navigate('/signup')} className="rounded-full bg-gradient-to-r from-[#2EE6A6] to-[#22D3EE] px-5 text-slate-950 shadow-[0_0_24px_rgba(34,211,238,0.28)]">
            {t('landing.cta.start')}
          </Button>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[0.92fr_1.08fr] lg:py-28">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#2EE6A6]/20 bg-[#2EE6A6]/8 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.28em] text-[#2EE6A6]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#2EE6A6] shadow-[0_0_16px_rgba(46,230,166,0.9)]" />
            {t('landing.tagline')}
          </div>

          <h1 className="max-w-4xl text-balance text-5xl font-black leading-[0.96] tracking-[-0.055em] text-slate-50 sm:text-6xl lg:text-7xl">
            {t('landing.headline')}
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-slate-300">
            {t('landing.sub')}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button onClick={() => navigate('/signup')} className="rounded-full bg-gradient-to-r from-[#2EE6A6] to-[#22D3EE] px-6 py-3 text-base text-slate-950 shadow-[0_0_32px_rgba(46,230,166,0.25)]">
              {t('landing.cta.start')}
            </Button>
            <Button variant="ghost" onClick={() => navigate('/docs')} className="rounded-full border-white/15 px-6 py-3 text-base">
              {t('landing.cta.docs')}
            </Button>
          </div>

          <div className="mt-8 flex flex-wrap gap-2">
            {TRUST_SIGNALS.map(key => (
              <span key={key} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-medium text-slate-300">
                {t(`landing.feat.${key}.t`)}
              </span>
            ))}
          </div>
        </div>

        {/* Animated product visual */}
        <Card glow className="relative overflow-hidden rounded-[2rem] border-white/10 bg-[#071014]/82 p-4 shadow-[0_30px_120px_rgba(0,0,0,0.42)]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(46,230,166,0.14),transparent_34%),radial-gradient(circle_at_100%_24%,rgba(34,211,238,0.12),transparent_30%)]" />
          <div className="akis-scanline" />

          <div className="relative rounded-[1.5rem] border border-white/10 bg-black/30 p-5 backdrop-blur-md">
            <div className="mb-5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <AkisLogo size={30} alt="" />
                <div>
                  <div className="text-sm font-bold tracking-[0.24em] text-slate-100">AKIS</div>
                  <div className="text-xs text-slate-500">verified build run</div>
                </div>
              </div>
              <div className="rounded-full border border-[#2EE6A6]/25 bg-[#2EE6A6]/10 px-3 py-1 text-xs font-semibold text-[#2EE6A6]">98.7%</div>
            </div>

            <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
              <div className="relative grid min-h-64 place-items-center rounded-3xl border border-white/10 bg-white/[0.025]">
                <div className="akis-orbit" aria-hidden="true">
                  <span className="akis-orbit-dot" />
                  <span className="akis-orbit-dot akis-orbit-dot--cyan" />
                  <span className="akis-orbit-dot akis-orbit-dot--small" />
                </div>
                <AkisLogo size={128} className="akis-float-slow drop-shadow-[0_0_44px_rgba(46,230,166,0.48)]" />
              </div>

              <div className="space-y-2.5">
                {CHAIN.map((step, i) => (
                  <div key={step.agent} className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3">
                    <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[#2EE6A6] to-[#22D3EE] opacity-80" />
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <span className="grid h-8 w-8 place-items-center rounded-full border border-[#2EE6A6]/25 bg-[#2EE6A6]/10 text-[11px] font-black text-[#2EE6A6]">0{i + 1}</span>
                        <div>
                          <div className="text-sm font-bold text-slate-100">{step.agent}</div>
                          <div className="text-xs text-slate-500">{step.action}</div>
                        </div>
                      </div>
                      <span className="rounded-full bg-[#2EE6A6]/10 px-2.5 py-1 text-[11px] font-semibold text-[#2EE6A6]">{step.state}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </section>

      {/* How it works */}
      <section className="relative z-10 border-y border-white/10 py-14">
        <div className="mb-8 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.32em] text-[#2EE6A6]">{t('landing.features.title')}</div>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-50 sm:text-4xl">{t('landing.how.title')}</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-slate-400">{t('docs.gates.body')}</p>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          {STEPS.map((s, i) => (
            <Card key={s} className="group relative overflow-hidden p-5 transition duration-300 hover:-translate-y-1 hover:border-[#2EE6A6]/30 hover:bg-white/[0.055]">
              <div className="mb-5 flex items-center justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-[#2EE6A6] to-[#22D3EE] text-sm font-black text-slate-950 shadow-[0_0_28px_rgba(46,230,166,0.22)]">0{i + 1}</div>
                <div className="h-px flex-1 bg-gradient-to-r from-[#2EE6A6]/50 to-transparent" />
              </div>
              <h3 className="text-base font-bold text-slate-100">{t(`landing.how.${s}.t`)}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">{t(`landing.how.${s}.d`)}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Feature grid */}
      <section className="relative z-10 py-14">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURE_KEYS.map((feature, i) => (
            <Card key={feature} className="relative overflow-hidden p-6 transition duration-300 hover:-translate-y-1 hover:border-[#22D3EE]/30 hover:bg-white/[0.055]">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-sm font-black text-[#2EE6A6]">
                {String(i + 1).padStart(2, '0')}
              </div>
              <h3 className="text-lg font-bold text-slate-100">{t(`landing.feat.${feature}.t`)}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">{t(`landing.feat.${feature}.d`)}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* CTA + footer */}
      <section className="relative z-10 mb-8 overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.025] p-8 text-center shadow-[0_30px_100px_rgba(0,0,0,0.26)] sm:p-12">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(46,230,166,0.16),transparent_36%)]" />
        <div className="relative mx-auto max-w-2xl">
          <AkisLogo size={58} className="mx-auto mb-5 drop-shadow-[0_0_28px_rgba(46,230,166,0.42)]" />
          <h2 className="text-3xl font-black tracking-[-0.04em] text-slate-50 sm:text-4xl">{t('landing.headline')}</h2>
          <p className="mt-4 text-slate-400">{t('app.subtitle')}</p>
          <div className="mt-7 flex justify-center">
            <Button onClick={() => navigate('/signup')} className="rounded-full bg-gradient-to-r from-[#2EE6A6] to-[#22D3EE] px-7 py-3 text-base text-slate-950">
              {t('landing.cta.start')}
            </Button>
          </div>
        </div>
      </section>

      <footer className="relative z-10 flex flex-col items-center justify-between gap-3 border-t border-white/10 py-8 text-xs text-slate-500 sm:flex-row">
        <div className="flex items-center gap-2"><AkisLogo size={22} alt="" />{t('landing.footer')}</div>
        <div className="flex gap-4"><Link to="/docs" className="hover:text-slate-300">{t('nav.docs')}</Link><Link to="/login" className="hover:text-slate-300">{t('landing.cta.signin')}</Link></div>
      </footer>
    </div>
  )
}
