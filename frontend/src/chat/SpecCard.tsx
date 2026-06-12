import { useEffect, useState } from 'react'
import { Markdown } from '../components/Markdown.js'
import { CopyButton } from '../components/CopyButton.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import type { SpecChipStatus } from './specChipStatus.js'

/** Status-aware copy for the COLLAPSED chip subtitle (P1-4): a settled run must not read
 *  "building" forever. Falls back to the in-flight label for the default/unknown bucket. */
const COLLAPSED_KEY: Record<SpecChipStatus, StringKey> = {
  building: 'spec.collapsed',
  done: 'spec.collapsed.done',
  parked: 'spec.collapsed.parked',
}

/**
 * A read-only preview of an AKIS-authored, build-ready spec (detected via the `akis-spec`
 * contract). Renders the spec with the shared `<Markdown>`, offers a client-side `.md`
 * download (a `Blob` — no server write, no path handling), and exposes ONE approval that
 * hands the spec to `onBuild`. The spec then flows through the UNCHANGED `startSession`
 * path → the same 4 structural gates + pipeline; this card holds no build authority.
 */
export function SpecCard({ spec, onBuild, building, started, startedSpec, isSpecStarted, runStatus }: { spec: string; onBuild: (spec: string) => void; building?: boolean; started?: boolean; startedSpec?: string | undefined; isSpecStarted?: ((spec: string) => boolean) | undefined; runStatus?: SpecChipStatus | undefined }) {
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
  // H1-Fix-B: once the build has STARTED, the approved spec is no longer the thing being read — it
  // was eating ~60vh above the live activity. Collapse its body by default to a one-line summary
  // chip + a "Show spec" toggle. `expanded` is user intent (lets them re-reveal it); we DEFAULT it
  // to !isStarted via the effect below so a fresh card is open and a started card is collapsed.
  const [expanded, setExpanded] = useState(!isStarted)
  // Re-sync the default whenever started-state flips (a card that transitions to "started" while
  // mounted should auto-collapse) or the spec text changes (a new card resets to open). Editing
  // force-opens so the textarea is always usable.
  useEffect(() => { setExpanded(!isStarted) }, [isStarted, spec])
  const showBody = expanded || editing
  const specTitle = titleFromSpec(currentSpec)

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
      {showBody ? (
        <>
          {/* When the build has started but the body is shown (user re-opened it), offer a way to
              re-collapse so it stops dominating again. Hidden for a not-yet-started card (the body
              is the point) and while editing (the textarea must stay open). */}
          {isStarted && !editing && (
            <button type="button" onClick={() => setExpanded(false)}
              className="mb-2 text-xs font-medium text-teal-300 hover:text-teal-200">
              {t('spec.hide')}
            </button>
          )}
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
        </>
      ) : (
        // Collapsed (started) state: a one-line summary chip + a "Show spec" toggle, so the approved
        // spec stops eating ~60vh above the live build activity (H1-Fix-B).
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-slate-950/40 px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm text-slate-200" title={specTitle}>{specTitle}</div>
            {/* P1-4 — RUN-STATUS aware: a verified/finished build reads "build complete", a failed/
                cancelled/parked one "build stopped" (amber), only an in-flight one keeps "building".
                Default (no runStatus passed — standalone callers/tests) is the legacy in-flight copy. */}
            <div className={`text-xs ${runStatus === 'parked' ? 'text-amber-300/80' : 'text-emerald-300/80'}`}>{t(COLLAPSED_KEY[runStatus ?? 'building'])}</div>
          </div>
          <button type="button" onClick={() => setExpanded(true)}
            className="shrink-0 rounded-lg border border-white/15 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-white/30">
            {t('spec.show')}
          </button>
        </div>
      )}
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

/** The spec's first markdown heading (the human title), or its first non-empty line trimmed, for
 *  the collapsed summary chip — never blank (falls back to a generic line so the chip always reads). */
function titleFromSpec(spec: string): string {
  const heading = /^[ \t]*#{1,6}[ \t]+(.+)$/m.exec(spec)?.[1]?.trim()
  if (heading) return heading
  const firstLine = spec.split('\n').map(l => l.trim()).find(l => l.length > 0)
  return firstLine ?? 'Spec'
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
