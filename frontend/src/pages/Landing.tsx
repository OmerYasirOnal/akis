import { useI18n } from '../i18n/I18nContext.js'
import { Link, useRouter } from '../router/router.js'
import { AkisLogo } from '../components/AkisLogo.js'
import { Card, Button } from '../ui/kit.js'

const BUILD_CHAIN = [
  { step: '01', title: 'Spec onayı', body: 'Fikir önce net bir ürün spesifikasyonuna dönüşür; insan onayı olmadan üretim başlamaz.' },
  { step: '02', title: 'Ajan üretimi', body: 'Scribe planlar, Proto kodlar; üretici ajan doğrulayıcı ajanla aynı değildir.' },
  { step: '03', title: 'Gerçek doğrulama', body: 'Trace testleri çalıştırır, Critic kaliteyi denetler; “çalışıyor gibi” değil, kanıtlı çıktı.' },
  { step: '04', title: 'Ship kapısı', body: 'Push ve yayın kararı son kapıdan geçer; kontrol insanda, hız ajanlarda kalır.' },
] as const

const PORTFOLIO_ITEMS = [
  {
    eyebrow: 'A2 reklamı',
    title: 'Minimal, akılda kalan AI reklam kurgusu',
    body: 'AKIS için sade, üç renkli, Google tarzı kısa mesaj mimarisi: iki heceli algı, net kontrast, hızlı güven sinyali.',
    tags: ['Reklam', 'Marka dili', 'AI üretim'],
  },
  {
    eyebrow: 'Özsaye',
    title: 'Finansal düşünceyi ürünleştiren vitrin',
    body: 'Sermaye, güven ve doğrulanabilir değer temasını AKIS’in “quality trust” teziyle birleştiren portföy parçası.',
    tags: ['Finans', 'Strateji', 'Portföy'],
  },
  {
    eyebrow: 'AKIS ile üretildi',
    title: 'AI tabanlı web sitesi üretim hattı',
    body: 'Bu landing, AKIS’in iddiasını anlatan değil, aynı zamanda AKIS etrafında ürünleştirilen portföy yüzeyi olarak tasarlandı.',
    tags: ['React', 'AI-first', 'Portfolio'],
  },
] as const

const SIGNALS = ['AI-first portfolio', 'Verified build logic', 'A2 reklamı', 'Özsaye', 'omeryasironal.com'] as const

function ChromeMockup() {
  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#05080d]/90 p-3 shadow-[0_40px_140px_rgba(0,0,0,0.45)]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_0%,rgba(7,209,175,0.22),transparent_32%),radial-gradient(circle_at_90%_20%,rgba(168,85,247,0.18),transparent_30%)]" />
      <div className="relative rounded-[1.5rem] border border-white/10 bg-black/35 backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
            <span className="h-2.5 w-2.5 rounded-full bg-white/20" />
          </div>
          <div className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-1 text-[11px] text-slate-400">omeryasironal.com</div>
          <div className="h-2.5 w-12 rounded-full bg-[#07D1AF]/25" />
        </div>

        <div className="grid gap-4 p-5 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-3xl border border-white/10 bg-white/[0.035] p-5">
            <div className="mb-5 flex items-center gap-3">
              <AkisLogo size={36} className="drop-shadow-[0_0_24px_rgba(7,209,175,0.5)]" />
              <div>
                <div className="text-xs font-black tracking-[0.34em] text-slate-100">AKIS</div>
                <div className="text-xs text-slate-500">verified portfolio engine</div>
              </div>
            </div>
            <div className="space-y-3">
              {BUILD_CHAIN.map(item => (
                <div key={item.step} className="rounded-2xl border border-white/10 bg-black/25 p-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-mono text-[11px] text-[#07D1AF]">{item.step}</span>
                    <span className="rounded-full bg-[#07D1AF]/10 px-2 py-0.5 text-[10px] font-bold text-[#07D1AF]">verified</span>
                  </div>
                  <div className="text-sm font-bold text-slate-100">{item.title}</div>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{item.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="relative grid min-h-[440px] place-items-center overflow-hidden rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_50%_36%,rgba(7,209,175,0.18),transparent_34%),linear-gradient(160deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))] p-6">
            <div className="absolute h-72 w-72 rounded-full border border-[#07D1AF]/25" />
            <div className="absolute h-48 w-48 rounded-full border border-cyan-300/20" />
            <div className="absolute h-96 w-96 animate-pulse rounded-full bg-[#07D1AF]/10 blur-3xl" />
            <div className="relative text-center">
              <AkisLogo size={134} className="mx-auto drop-shadow-[0_0_54px_rgba(7,209,175,0.58)]" />
              <div className="mt-6 inline-flex rounded-full border border-[#07D1AF]/20 bg-[#07D1AF]/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.24em] text-[#07D1AF]">AI based web site</div>
              <h3 className="mt-5 text-3xl font-black tracking-[-0.05em] text-slate-50">AKIS ile üretilmiş portföy</h3>
              <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-slate-400">A2 reklamı, Özsaye ve ürün geliştirme çalışmalarını tek, premium ve doğrulanabilir vitrine toplar.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export function Landing() {
  const { locale, setLocale } = useI18n()
  const { navigate } = useRouter()

  return (
    <div className="relative mx-auto max-w-7xl overflow-hidden px-4 py-6 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute left-1/2 top-0 h-[34rem] w-[34rem] -translate-x-1/2 rounded-full bg-[#07D1AF]/12 blur-3xl" />
      <div className="pointer-events-none absolute right-[-10%] top-56 h-[30rem] w-[30rem] rounded-full bg-violet-500/12 blur-3xl" />

      <header className="relative z-20 flex flex-wrap items-center justify-between gap-3">
        <Link to="/" className="flex items-center gap-3">
          <AkisLogo size={34} alt="" className="drop-shadow-[0_0_18px_rgba(7,209,175,0.45)]" />
          <div>
            <div className="text-sm font-black tracking-[0.32em] text-slate-100">AKIS</div>
            <div className="text-[11px] text-slate-500">Ömer Yasir Önal portfolio</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setLocale(locale === 'en' ? 'tr' : 'en')}
            aria-label="Dili değiştir"
            className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-[#07D1AF]/40 hover:text-slate-100"
          >
            {locale.toUpperCase()}
          </button>
          <a href="mailto:engomeryasironal@gmail.com" className="rounded-full px-3 py-1.5 text-sm text-slate-300 transition hover:text-slate-100">İletişim</a>
          <Link to="/docs" className="rounded-full px-3 py-1.5 text-sm text-slate-300 transition hover:text-slate-100">AKIS docs</Link>
          <Button onClick={() => navigate('/signup')} className="rounded-full bg-gradient-to-r from-[#07D1AF] to-cyan-300 px-5 text-slate-950 shadow-[0_0_24px_rgba(7,209,175,0.28)]">
            Stüdyoyu aç
          </Button>
        </div>
      </header>

      <section className="relative z-10 grid items-center gap-12 py-16 sm:py-24 lg:grid-cols-[0.86fr_1.14fr] lg:py-28">
        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[#07D1AF]/20 bg-[#07D1AF]/8 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.28em] text-[#07D1AF]">
            <span className="h-1.5 w-1.5 rounded-full bg-[#07D1AF] shadow-[0_0_16px_rgba(7,209,175,0.9)]" />
            AI-first portfolio · AKIS produced
          </div>

          <h1 className="max-w-4xl text-balance text-5xl font-black leading-[0.94] tracking-[-0.06em] text-slate-50 sm:text-6xl lg:text-7xl">
            Ömer Yasir Önal için modern, cosmic ve AI tabanlı portföy.
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-slate-300">
            Bu site AKIS’in ürün vitrini gibi çalışır: AKIS ile üretilmiş web deneyimi, A2 reklamı, Özsaye ve doğrulanabilir AI geliştirme yaklaşımı tek alanda konumlanır.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button onClick={() => navigate('/signup')} className="rounded-full bg-gradient-to-r from-[#07D1AF] to-cyan-300 px-6 py-3 text-base text-slate-950 shadow-[0_0_32px_rgba(7,209,175,0.25)]">
              AKIS’i dene
            </Button>
            <Button variant="ghost" onClick={() => navigate('/docs')} className="rounded-full border-white/15 px-6 py-3 text-base">
              Sistem mantığını gör
            </Button>
          </div>

          <div className="mt-8 flex flex-wrap gap-2">
            {SIGNALS.map(signal => (
              <span key={signal} className="rounded-full border border-white/10 bg-white/[0.035] px-3 py-1.5 text-xs font-medium text-slate-300">
                {signal}
              </span>
            ))}
          </div>
        </div>

        <ChromeMockup />
      </section>

      <section className="relative z-10 border-y border-white/10 py-14">
        <div className="mb-8 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.32em] text-[#07D1AF]">Portfolio modules</div>
            <h2 className="mt-3 text-3xl font-black tracking-[-0.04em] text-slate-50 sm:text-4xl">A2 reklamı, Özsaye ve AKIS ürün vitrini</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-slate-400">Her parça tek başına iş gösterir; birlikte ise “AI ile fikirden çalışan ürüne” anlatısını kurar.</p>
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          {PORTFOLIO_ITEMS.map(item => (
            <Card key={item.eyebrow} className="group relative overflow-hidden p-6 transition duration-300 hover:-translate-y-1 hover:border-[#07D1AF]/30 hover:bg-white/[0.055]">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#07D1AF]/70 to-transparent opacity-0 transition group-hover:opacity-100" />
              <div className="mb-5 inline-flex rounded-full border border-[#07D1AF]/20 bg-[#07D1AF]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.22em] text-[#07D1AF]">{item.eyebrow}</div>
              <h3 className="text-xl font-black tracking-[-0.03em] text-slate-100">{item.title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-400">{item.body}</p>
              <div className="mt-6 flex flex-wrap gap-2">
                {item.tags.map(tag => <span key={tag} className="rounded-full bg-white/[0.045] px-2.5 py-1 text-[11px] text-slate-400">{tag}</span>)}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="relative z-10 py-14">
        <div className="grid gap-4 md:grid-cols-4">
          {BUILD_CHAIN.map(item => (
            <Card key={item.step} className="relative overflow-hidden p-5">
              <div className="mb-5 flex items-center justify-between">
                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-[#07D1AF] to-cyan-300 text-sm font-black text-slate-950 shadow-[0_0_28px_rgba(7,209,175,0.22)]">{item.step}</div>
                <div className="h-px flex-1 bg-gradient-to-r from-[#07D1AF]/50 to-transparent" />
              </div>
              <h3 className="text-base font-bold text-slate-100">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">{item.body}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="relative z-10 mb-8 overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.025] p-8 text-center shadow-[0_30px_100px_rgba(0,0,0,0.26)] sm:p-12">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(7,209,175,0.16),transparent_36%)]" />
        <div className="relative mx-auto max-w-2xl">
          <AkisLogo size={58} className="mx-auto mb-5 drop-shadow-[0_0_28px_rgba(7,209,175,0.42)]" />
          <h2 className="text-3xl font-black tracking-[-0.04em] text-slate-50 sm:text-4xl">omeryasironal.com için hazır portföy omurgası</h2>
          <p className="mt-4 text-slate-400">Domain’i GoDaddy’den aldıktan sonra bu frontend doğrudan ana vitrin olarak konumlandırılabilir. AKIS stüdyo ise ürünün canlı demo alanı gibi kalır.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button onClick={() => navigate('/signup')} className="rounded-full bg-gradient-to-r from-[#07D1AF] to-cyan-300 px-7 py-3 text-base text-slate-950">
              Canlı stüdyoya gir
            </Button>
            <a href="mailto:engomeryasironal@gmail.com" className="rounded-full border border-white/15 px-7 py-3 text-base font-semibold text-slate-200 transition hover:border-[#07D1AF]/35 hover:text-white">İletişime geç</a>
          </div>
        </div>
      </section>

      <footer className="relative z-10 flex flex-col items-center justify-between gap-3 border-t border-white/10 py-8 text-xs text-slate-500 sm:flex-row">
        <div className="flex items-center gap-2"><AkisLogo size={22} alt="" />AKIS · Ömer Yasir Önal portfolio</div>
        <div className="flex gap-4"><Link to="/docs" className="hover:text-slate-300">Docs</Link><Link to="/login" className="hover:text-slate-300">Studio login</Link></div>
      </footer>
    </div>
  )
}
