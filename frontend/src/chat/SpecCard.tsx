import { useEffect, useState } from 'react'
import { Markdown } from '../components/Markdown.js'
import { CopyButton } from '../components/CopyButton.js'
import { useI18n } from '../i18n/I18nContext.js'

/**
 * A read-only preview of an AKIS-authored, build-ready spec (detected via the `akis-spec`
 * contract). Renders the spec with the shared `<Markdown>`, offers a client-side `.md`
 * download (a `Blob` — no server write, no path handling), and exposes ONE approval that
 * hands the spec to `onBuild`. The spec then flows through the UNCHANGED `startSession`
 * path → the same 4 structural gates + pipeline; this card holds no build authority.
 */
export function SpecCard({ spec, onBuild, building, started, startedSpec, isSpecStarted }: { spec: string; onBuild: (spec: string) => void; building?: boolean; started?: boolean; startedSpec?: string | undefined; isSpecStarted?: ((spec: string) => boolean) | undefined }) {
  const { t } = useI18n()
  const [committedSpec, setCommittedSpec] = useState(spec)
  const [draft, setDraft] = useState(spec)
  const [editing, setEditing] = useState(false)
  useEffect(() => { setCommittedSpec(spec); setDraft(spec); setEditing(false) }, [spec])
  const cleanDraft = draft.trim()
  const currentSpec = editing ? (cleanDraft || committedSpec) : committedSpec
  // started = the `started` bool (original-text match) OR a startedSpec string match OR the
  // `isSpecStarted` predicate evaluated against THIS card's CURRENT (possibly EDITED) text — the
  // last is what makes an edited-then-built card correctly read "started" (the run marker carries
  // the EDITED text, which only currentSpec — not the original detected fence — equals).
  const isStarted = !!started || (!!startedSpec && startedSpec.trim() === currentSpec.trim()) || (isSpecStarted?.(currentSpec) ?? false)
  const canEdit = !building && !isStarted

  const download = (): void => {
    const blob = new Blob([currentSpec], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slugFromSpec(currentSpec)}.md`
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
      <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3">
        {editing ? (
          <textarea
            aria-label={t('spec.editLabel')}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            className="min-h-64 w-full resize-y bg-transparent text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-500"
          />
        ) : (
          <Markdown content={currentSpec} />
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {canEdit && (editing ? (
          <>
            <button type="button" onClick={() => { setDraft(committedSpec); setEditing(false) }}
              className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-slate-200 hover:border-white/30">
              {t('spec.cancel')}
            </button>
            <button type="button" onClick={() => { setCommittedSpec(cleanDraft); setDraft(cleanDraft); setEditing(false) }} disabled={!cleanDraft}
              className="rounded-xl border border-teal-400/30 bg-teal-400/10 px-3 py-2 text-sm font-semibold text-teal-200 hover:bg-teal-400/20 disabled:opacity-40">
              {t('spec.save')}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setEditing(true)}
            className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-slate-200 hover:border-white/30">
            {t('spec.edit')}
          </button>
        ))}
        {/* Copy the current spec text (edited or committed). Sits BEFORE Download, which is unchanged. */}
        <CopyButton text={currentSpec} label={t('copy.spec')}
          className="rounded-xl border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-slate-200 hover:border-white/30" />
        <button type="button" onClick={download}
          className="rounded-xl border border-white/15 bg-white/[0.04] px-3 py-2 text-sm font-medium text-slate-200 hover:border-white/30">
          <span aria-hidden="true">⬇ </span>{t('spec.download')}
        </button>
        <button type="button" onClick={() => onBuild(currentSpec)} disabled={building || isStarted || !currentSpec.trim()}
          className="rounded-xl bg-gradient-to-r from-[#07D1AF] to-violet-500 px-4 py-2 text-sm font-semibold text-slate-900 shadow-[0_0_20px_rgba(7,209,175,0.35)] hover:shadow-[0_0_28px_rgba(7,209,175,0.5)] disabled:opacity-50">
          <span aria-hidden="true">{isStarted ? '↪ ' : building ? '⏳ ' : '✓ '}</span>{isStarted ? t('spec.started') : building ? t('spec.building') : t('spec.build')}
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
