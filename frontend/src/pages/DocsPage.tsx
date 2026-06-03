import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { Link, useRouter } from '../router/router.js'
import { useAuth } from '../auth/AuthContext.js'
import { AkisLogo } from '../components/AkisLogo.js'

/**
 * The in-app /docs page — a real product manual for AKIS's current state.
 *
 * Layout: a sticky on-page table-of-contents rail (left, scroll-spy via
 * IntersectionObserver) beside the long-form content (right). Content is fully
 * i18n-driven (EN+TR parity, docs.v2.* namespace) and presentation-only — it
 * documents the shipped pipeline, the 4 structural gates, the agents, workflows,
 * settings, the live preview, self-hosting, and an FAQ. Renders inside the shared
 * max-width frame (AppFrame for signed-in users, PublicDocs for anon), so it does
 * not add its own page-width wrapper.
 */

/** The ordered sections — id drives the anchor, the TOC, and the scroll-spy. */
const SECTIONS = [
  'what', 'quickstart', 'studio', 'pipeline', 'gates',
  'agents', 'chat', 'workflows', 'settings', 'preview', 'selfhost', 'faq',
] as const
type SectionId = (typeof SECTIONS)[number]

const PIPELINE = ['s1', 's2', 's3', 's4', 's5'] as const
const GATES = ['g1', 'g2', 'g3', 'g4'] as const
const QUICK = ['step1', 'step2', 'step3', 'step4'] as const
const STUDIO_F = ['f1', 'f2', 'f3', 'f4'] as const
const WORKFLOW_B = ['b1', 'b2', 'b3', 'b4'] as const
const FAQ = ['1', '2', '3', '4', '5'] as const

const AGENTS = [
  { key: 'akis', tint: 'from-teal-400 to-teal-300', mono: 'AK' },
  { key: 'scribe', tint: 'from-sky-400 to-sky-300', mono: 'SC' },
  { key: 'proto', tint: 'from-violet-400 to-violet-300', mono: 'PR' },
  { key: 'trace', tint: 'from-emerald-400 to-emerald-300', mono: 'TR' },
  { key: 'critic', tint: 'from-amber-400 to-amber-300', mono: 'CR' },
] as const

const PROVIDERS = ['Anthropic (Claude)', 'OpenAI', 'OpenRouter', 'Google (Gemini)'] as const

/** A documentation section wrapper: an anchored heading + lead + body. */
function Section({ id, title, lead, children }: { id: SectionId; title: string; lead?: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-50 sm:text-3xl">{title}</h2>
      {lead && <p className="mt-3 max-w-2xl text-pretty text-base leading-7 text-slate-300">{lead}</p>}
      <div className="mt-6">{children}</div>
    </section>
  )
}

/** A monospaced code block with an optional caption above it. Static docs content;
 *  no execution, no user input — purely illustrative copy. */
function Code({ caption, lines, note }: { caption?: string; lines: string[]; note?: string }) {
  return (
    <figure className="my-1">
      {caption && <figcaption className="mb-2 text-sm text-slate-400">{caption}</figcaption>}
      <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-[#05090c]/80 p-4 text-[13px] leading-6 shadow-[0_0_40px_rgba(0,0,0,0.35)]">
        <code className="font-mono text-[#9ff3df]">
          {lines.map((l, i) => (
            <div key={i} className={l.startsWith('#') ? 'text-slate-500' : ''}>
              {l.startsWith('$') ? (
                <>
                  <span className="select-none text-violet-300/70">$ </span>
                  <span className="text-slate-100">{l.slice(2)}</span>
                </>
              ) : l || ' '}
            </div>
          ))}
        </code>
      </pre>
      {note && <p className="mt-2 text-xs leading-5 text-slate-500">{note}</p>}
    </figure>
  )
}

/** A tinted callout for important / caution notes. */
function Callout({ tone = 'info', children }: { tone?: 'info' | 'caution'; children: ReactNode }) {
  const styles = tone === 'caution'
    ? 'border-amber-400/30 bg-amber-400/[0.07] text-amber-100/90'
    : 'border-[#07D1AF]/30 bg-[#07D1AF]/[0.06] text-slate-200'
  const icon = tone === 'caution' ? '⚠' : '✦'
  const iconColor = tone === 'caution' ? 'text-amber-300' : 'text-[#07D1AF]'
  return (
    <div className={`flex gap-3 rounded-2xl border px-4 py-3.5 text-sm leading-6 ${styles}`}>
      <span aria-hidden className={`select-none text-base leading-6 ${iconColor}`}>{icon}</span>
      <div>{children}</div>
    </div>
  )
}

export function DocsPage() {
  const { t } = useI18n()
  const { user } = useAuth()
  const { navigate } = useRouter()
  const [active, setActive] = useState<SectionId>('what')
  const observed = useRef(false)

  // Scroll-spy: highlight the TOC entry whose section is nearest the top of the
  // viewport. Guarded for jsdom (no IntersectionObserver in the test env).
  useEffect(() => {
    if (observed.current || typeof IntersectionObserver === 'undefined') return
    observed.current = true
    const seen = new Map<SectionId, number>()
    const io = new IntersectionObserver(
      entries => {
        for (const e of entries) seen.set(e.target.id as SectionId, e.intersectionRatio)
        let best: SectionId = active
        let bestRatio = -1
        for (const id of SECTIONS) {
          const r = seen.get(id) ?? 0
          if (r > bestRatio) { bestRatio = r; best = id }
        }
        if (bestRatio > 0) setActive(best)
      },
      { rootMargin: '-72px 0px -55% 0px', threshold: [0, 0.25, 0.5, 1] },
    )
    for (const id of SECTIONS) { const el = document.getElementById(id); if (el) io.observe(el) }
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tk = (k: string): string => t(k as StringKey)

  return (
    <div className="relative">
      {/* Atmosphere */}
      <div className="pointer-events-none absolute -left-20 top-0 h-72 w-72 rounded-full bg-[#07D1AF]/10 blur-3xl" />
      <div className="pointer-events-none absolute right-0 top-40 h-80 w-80 rounded-full bg-violet-500/10 blur-3xl" />

      {/* Hero */}
      <header className="relative mb-12 border-b border-white/10 pb-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-[#07D1AF]/25 bg-[#07D1AF]/[0.08] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.28em] text-[#07D1AF]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#07D1AF] shadow-[0_0_14px_rgba(7,209,175,0.9)]" />
          {tk('docs.v2.badge')}
        </div>
        <h1 className="mt-5 flex items-center gap-4 text-4xl font-black tracking-[-0.045em] text-slate-50 sm:text-5xl">
          <AkisLogo size={44} alt="" className="hidden shrink-0 drop-shadow-[0_0_20px_rgba(7,209,175,0.45)] sm:block" />
          <span className="bg-gradient-to-r from-[#07D1AF] via-cyan-200 to-violet-300 bg-clip-text text-transparent">{tk('docs.v2.title')}</span>
        </h1>
        <p className="mt-5 max-w-3xl text-pretty text-lg leading-8 text-slate-300">{tk('docs.v2.lead')}</p>
        <div className="mt-5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1">{tk('docs.v2.readingTime')}</span>
          <a
            href="https://github.com/OmerYasirOnal/akis-platform-mvp"
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 transition hover:border-[#07D1AF]/40 hover:text-slate-300"
          >
            {tk('docs.v2.editLink')} ↗
          </a>
        </div>
      </header>

      <div className="grid gap-10 lg:grid-cols-[15rem_1fr]">
        {/* Sticky table of contents */}
        <aside className="hidden lg:block">
          <nav aria-label={tk('docs.v2.toc')} className="sticky top-20">
            <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.24em] text-slate-500">{tk('docs.v2.toc')}</div>
            <ul className="space-y-0.5 border-l border-white/10">
              {SECTIONS.map(id => {
                const on = active === id
                return (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      onClick={() => setActive(id)}
                      className={`-ml-px block border-l-2 py-1.5 pl-4 text-sm transition ${
                        on
                          ? 'border-[#07D1AF] font-medium text-[#07D1AF]'
                          : 'border-transparent text-slate-400 hover:border-white/30 hover:text-slate-200'
                      }`}
                    >
                      {tk(`docs.v2.nav.${id}`)}
                    </a>
                  </li>
                )
              })}
            </ul>
          </nav>
        </aside>

        {/* Content */}
        <div className="flex min-w-0 max-w-3xl flex-col gap-16">
          {/* What is AKIS */}
          <Section id="what" title={tk('docs.v2.what.title')} lead={tk('docs.v2.what.lead')}>
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap gap-2">
                {(['pill1', 'pill2', 'pill3', 'pill4'] as const).map(p => (
                  <span key={p} className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200">
                    {tk(`docs.v2.what.${p}`)}
                  </span>
                ))}
              </div>
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.what.p1')}</p>
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.what.p2')}</p>
              <Callout tone="caution">{tk('docs.v2.what.callout')}</Callout>
            </div>
          </Section>

          {/* Quickstart */}
          <Section id="quickstart" title={tk('docs.v2.quickstart.title')} lead={tk('docs.v2.quickstart.lead')}>
            <ol className="mb-7 grid gap-3 sm:grid-cols-2">
              {QUICK.map((s, i) => (
                <li key={s} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4 transition hover:border-[#07D1AF]/30 hover:bg-white/[0.04]">
                  <div className="mb-2 grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-[#07D1AF] to-violet-500 text-sm font-black text-slate-950 shadow-[0_0_18px_rgba(7,209,175,0.3)]">{i + 1}</div>
                  <div className="text-sm font-bold text-slate-100">{tk(`docs.v2.quickstart.${s}.t`)}</div>
                  <p className="mt-1 text-sm leading-6 text-slate-400">{tk(`docs.v2.quickstart.${s}.d`)}</p>
                </li>
              ))}
            </ol>
            <Code
              caption={tk('docs.v2.quickstart.codeCaption')}
              lines={['# from the repo root', '$ docker compose up', '', '$ open http://localhost:3000']}
              note={tk('docs.v2.quickstart.codeNote')}
            />
          </Section>

          {/* The Studio */}
          <Section id="studio" title={tk('docs.v2.studio.title')} lead={tk('docs.v2.studio.lead')}>
            <div className="grid gap-3 sm:grid-cols-2">
              {STUDIO_F.map(f => (
                <div key={f} className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
                  <div className="text-sm font-bold text-slate-100">{tk(`docs.v2.studio.${f}.t`)}</div>
                  <p className="mt-1.5 text-sm leading-6 text-slate-400">{tk(`docs.v2.studio.${f}.d`)}</p>
                </div>
              ))}
            </div>
          </Section>

          {/* Pipeline & stages */}
          <Section id="pipeline" title={tk('docs.v2.pipeline.title')} lead={tk('docs.v2.pipeline.lead')}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
              {PIPELINE.map((s, i) => (
                <div key={s} className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-black tabular-nums text-[#07D1AF]">{['①', '②', '③', '④', '⑤'][i]}</span>
                      <span className="truncate text-xs font-bold text-slate-100">{tk(`docs.v2.pipeline.${s}.t`)}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-5 text-slate-400">{tk(`docs.v2.pipeline.${s}.d`)}</p>
                  </div>
                  {i < PIPELINE.length - 1 && <span aria-hidden className="hidden shrink-0 text-slate-600 sm:inline">→</span>}
                </div>
              ))}
            </div>
          </Section>

          {/* The 4 gates */}
          <Section id="gates" title={tk('docs.v2.gates.title')} lead={tk('docs.v2.gates.lead')}>
            <div className="grid gap-3 sm:grid-cols-2">
              {GATES.map((g, i) => {
                const human = tk(`docs.v2.gates.${g}.tag`) === tk('docs.v2.gates.g1.tag')
                return (
                  <div key={g} className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.025] p-5">
                    <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[#07D1AF] to-violet-500 opacity-80" />
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-full border border-[#07D1AF]/25 bg-[#07D1AF]/10 text-xs font-black text-[#07D1AF]">{i + 1}</span>
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide ${human ? 'bg-amber-400/10 text-amber-300' : 'bg-[#07D1AF]/10 text-[#07D1AF]'}`}>
                        {tk(`docs.v2.gates.${g}.tag`)}
                      </span>
                    </div>
                    <div className="text-sm font-bold text-slate-100">{tk(`docs.v2.gates.${g}.t`)}</div>
                    <p className="mt-1.5 text-sm leading-6 text-slate-400">{tk(`docs.v2.gates.${g}.d`)}</p>
                  </div>
                )
              })}
            </div>
            <div className="mt-4"><Callout>{tk('docs.v2.gates.callout')}</Callout></div>
          </Section>

          {/* The agents */}
          <Section id="agents" title={tk('docs.v2.agents.title')} lead={tk('docs.v2.agents.lead')}>
            <div className="flex flex-col gap-2.5">
              {AGENTS.map(a => (
                <div key={a.key} className="flex items-start gap-4 rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${a.tint} text-xs font-black text-slate-950`}>{a.mono}</span>
                  <div>
                    <div className="text-sm font-bold text-slate-100">{tk(`docs.v2.agents.${a.key}.t`)}</div>
                    <p className="mt-1 text-sm leading-6 text-slate-400">{tk(`docs.v2.agents.${a.key}.d`)}</p>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          {/* Ask AKIS & Chat-to-Build */}
          <Section id="chat" title={tk('docs.v2.chat.title')} lead={tk('docs.v2.chat.lead')}>
            <div className="flex flex-col gap-4">
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.chat.p1')}</p>
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.chat.p2')}</p>
            </div>
          </Section>

          {/* Workflows */}
          <Section id="workflows" title={tk('docs.v2.workflows.title')} lead={tk('docs.v2.workflows.lead')}>
            <ul className="mb-4 grid gap-2.5 sm:grid-cols-2">
              {WORKFLOW_B.map(b => (
                <li key={b} className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.025] px-4 py-3 text-sm leading-6 text-slate-300">
                  <span aria-hidden className="mt-0.5 select-none text-[#07D1AF]">▸</span>
                  {tk(`docs.v2.workflows.${b}`)}
                </li>
              ))}
            </ul>
            <Callout>{tk('docs.v2.workflows.p1')}</Callout>
          </Section>

          {/* Settings & provider keys */}
          <Section id="settings" title={tk('docs.v2.settings.title')} lead={tk('docs.v2.settings.lead')}>
            <div className="flex flex-col gap-5">
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.settings.p1')}</p>
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">{tk('docs.v2.settings.providers')}</div>
                <div className="flex flex-wrap gap-2">
                  {PROVIDERS.map(p => (
                    <span key={p} className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200">{p}</span>
                  ))}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
                <div className="text-sm font-bold text-slate-100">{tk('docs.v2.settings.real')}</div>
                <p className="mt-1.5 text-sm leading-6 text-slate-400">{tk('docs.v2.settings.realBody')}</p>
              </div>
            </div>
          </Section>

          {/* Live preview & verification */}
          <Section id="preview" title={tk('docs.v2.preview.title')} lead={tk('docs.v2.preview.lead')}>
            <div className="flex flex-col gap-4">
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.preview.p1')}</p>
              <p className="text-base leading-7 text-slate-300">{tk('docs.v2.preview.p2')}</p>
            </div>
          </Section>

          {/* Self-hosting */}
          <Section id="selfhost" title={tk('docs.v2.selfhost.title')} lead={tk('docs.v2.selfhost.lead')}>
            <div className="flex flex-col gap-5">
              <Code
                caption={tk('docs.v2.selfhost.code1Caption')}
                lines={['# from the repo root', '$ docker compose up']}
              />
              <Code
                caption={tk('docs.v2.selfhost.code2Caption')}
                lines={[
                  '# .env  (next to docker-compose.yml)',
                  'ANTHROPIC_API_KEY=sk-ant-...',
                  'AUTH_JWT_SECRET=$(openssl rand -hex 32)',
                  'DATABASE_URL=postgres://akis:akis@db:5432/akis',
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-3">
                {(['persist', 'secret', 'host'] as const).map(k => (
                  <div key={k} className="rounded-2xl border border-white/10 bg-white/[0.025] p-4">
                    <div className="text-sm font-bold text-slate-100">{tk(`docs.v2.selfhost.${k}.t`)}</div>
                    <p className="mt-1.5 text-xs leading-5 text-slate-400">{tk(`docs.v2.selfhost.${k}.d`)}</p>
                  </div>
                ))}
              </div>
              <Callout>{tk('docs.v2.selfhost.callout')}</Callout>
            </div>
          </Section>

          {/* FAQ & troubleshooting */}
          <Section id="faq" title={tk('docs.v2.faq.title')} lead={tk('docs.v2.faq.lead')}>
            <div className="flex flex-col gap-2.5">
              {FAQ.map(n => (
                <details key={n} className="group rounded-2xl border border-white/10 bg-white/[0.025] [&_summary]:list-none">
                  <summary className="flex cursor-pointer items-center justify-between gap-3 px-5 py-4 text-sm font-semibold text-slate-100">
                    {tk(`docs.v2.faq.q${n}`)}
                    <span aria-hidden className="shrink-0 text-slate-500 transition group-open:rotate-45">+</span>
                  </summary>
                  <p className="border-t border-white/10 px-5 py-4 text-sm leading-6 text-slate-400">{tk(`docs.v2.faq.a${n}`)}</p>
                </details>
              ))}
            </div>
          </Section>

          {/* Closing CTA */}
          <section className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/[0.08] to-white/[0.02] p-8 text-center sm:p-10">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(7,209,175,0.16),transparent_38%)]" />
            <div className="relative mx-auto max-w-xl">
              <AkisLogo size={48} className="mx-auto mb-4 drop-shadow-[0_0_24px_rgba(7,209,175,0.42)]" />
              <h2 className="text-2xl font-black tracking-[-0.03em] text-slate-50">{tk('docs.v2.cta.title')}</h2>
              <p className="mt-3 text-slate-400">{tk('docs.v2.cta.body')}</p>
              <div className="mt-6 flex justify-center">
                {user ? (
                  <button
                    onClick={() => navigate('/')}
                    className="rounded-full bg-gradient-to-r from-[#07D1AF] to-violet-500 px-7 py-3 text-base font-semibold text-slate-950 shadow-[0_0_28px_rgba(7,209,175,0.3)] transition hover:brightness-110"
                  >
                    {tk('docs.v2.cta.button')}
                  </button>
                ) : (
                  <Link
                    to="/signup"
                    className="rounded-full bg-gradient-to-r from-[#07D1AF] to-violet-500 px-7 py-3 text-base font-semibold text-slate-950 shadow-[0_0_28px_rgba(7,209,175,0.3)] transition hover:brightness-110"
                  >
                    {tk('docs.v2.cta.signin')}
                  </Link>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
