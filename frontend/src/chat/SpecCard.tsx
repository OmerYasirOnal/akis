import { Markdown } from '../components/Markdown.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * A read-only preview of an AKIS-authored, build-ready spec (detected via the `akis-spec`
 * contract). Renders the spec with the shared `<Markdown>`, offers a client-side `.md`
 * download (a `Blob` — no server write, no path handling), and exposes ONE approval that
 * hands the spec to `onBuild`. The spec then flows through the UNCHANGED `startSession`
 * path → the same 4 structural gates + pipeline; this card holds no build authority.
 */
export function SpecCard({ spec, onBuild, building }: { spec: string; onBuild: (spec: string) => void; building?: boolean }) {
  const { t } = useI18n()

  const download = (): void => {
    const blob = new Blob([spec], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slugFromSpec(spec)}.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="rounded-2xl border border-[#07D1AF]/25 bg-gradient-to-br from-[#07D1AF]/[0.06] to-violet-500/[0.06] p-4 shadow-[0_0_40px_rgba(7,209,175,0.08)]">
      <div className="mb-3 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-gradient-to-br from-[#07D1AF] to-violet-500 text-[10px] font-black text-slate-950">✦</span>
        <div>
          <div className="text-sm font-semibold text-slate-100">{t('spec.card.title')}</div>
          <div className="text-xs text-slate-400">{t('spec.card.hint')}</div>
        </div>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3">
        <Markdown content={spec} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={download}
          className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-slate-200 hover:border-white/30">
          <span aria-hidden="true">⬇ </span>{t('spec.download')}
        </button>
        <button type="button" onClick={() => onBuild(spec)} disabled={building}
          className="rounded-xl bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 text-sm font-semibold text-slate-900 shadow-[0_0_20px_rgba(7,209,175,0.35)] hover:shadow-[0_0_28px_rgba(7,209,175,0.5)] disabled:opacity-50">
          <span aria-hidden="true">{building ? '⏳ ' : '✓ '}</span>{building ? t('spec.building') : t('spec.build')}
        </button>
      </div>
    </div>
  )
}

/** Derive a filename slug from the spec's first markdown heading; else "akis-spec". */
function slugFromSpec(spec: string): string {
  const heading = /^[ \t]*#{1,6}[ \t]+(.+)$/m.exec(spec)?.[1]?.trim()
  const slug = (heading ?? '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'akis-spec'
}
