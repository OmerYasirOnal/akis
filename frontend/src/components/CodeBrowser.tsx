import { useMemo, useState } from 'react'
import type { CodeArtifact } from '@akis/shared'
import { useI18n } from '../i18n/I18nContext.js'

type CodeFile = CodeArtifact['files'][number]

/**
 * Read-only browser for the code the agents wrote (SessionState.code.files). A file list
 * on the left (sorted by path) and a viewer on the right that shows the SELECTED file's
 * content in a monospace `<pre>` with a line-number gutter.
 *
 * NO-XSS: file `content` and `filePath` are rendered as plain TEXT (React auto-escapes
 * children) — never dangerouslySetInnerHTML — so an agent-written file containing
 * `<script>` shows up as literal source, never as an injected/executed node. No syntax
 * highlighting dep: a plain <pre> + a simple gutter keeps the bundle lean (self-hostable).
 */
export function CodeBrowser({ files }: { files?: CodeFile[] | undefined }) {
  const { t } = useI18n()
  // Sort by path for a stable, scannable list (a copy — never mutate the prop array).
  const sorted = useMemo(
    () => (files ?? []).slice().sort((a, b) => a.filePath.localeCompare(b.filePath)),
    [files],
  )
  const [selected, setSelected] = useState(0)
  // Clamp the selection so a shrinking file list can never leave it out of range.
  const active = sorted.length ? sorted[Math.min(selected, sorted.length - 1)] : undefined

  if (sorted.length === 0) {
    return (
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-200">{t('code.title')}</h3>
        </div>
        <div className="flex flex-1 items-center justify-center rounded-xl border border-white/10 bg-black/40 p-4 text-center">
          <span className="text-sm text-slate-500">{t('code.empty')}</span>
        </div>
      </div>
    )
  }

  const lines = active ? active.content.split('\n') : []

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-200">{t('code.title')}</h3>
        <span className="rounded bg-white/[0.06] px-2 py-0.5 text-xs text-slate-400">
          {sorted.length} {t('code.files')}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[10rem_1fr] gap-2 overflow-hidden rounded-xl border border-white/10 bg-black/50">
        {/* File list */}
        <ul className="min-h-0 overflow-y-auto border-r border-white/10 py-1" aria-label={t('code.title')}>
          {sorted.map((f, i) => {
            const isActive = f === active
            return (
              <li key={f.filePath}>
                <button
                  type="button"
                  onClick={() => setSelected(i)}
                  aria-current={isActive}
                  title={f.filePath}
                  className={`block w-full truncate px-2.5 py-1 text-left text-xs ${
                    isActive ? 'bg-[#07D1AF]/15 text-[#07D1AF]' : 'text-slate-400 hover:bg-white/[0.04] hover:text-slate-200'
                  }`}
                >
                  {f.filePath}
                </button>
              </li>
            )
          })}
        </ul>

        {/* Viewer: line-number gutter + monospace source. content is rendered as TEXT. */}
        <div className="flex min-h-0 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-2.5 py-1">
            <span className="truncate text-[11px] text-slate-400">{active?.filePath}</span>
            <span className="shrink-0 pl-2 text-[10px] text-slate-600">{lines.length} {t('code.lines')}</span>
          </div>
          <div className="flex min-h-0 flex-1 overflow-auto font-mono text-xs leading-5">
            <ol data-testid="code-gutter" aria-hidden className="shrink-0 select-none border-r border-white/10 px-2 py-2 text-right text-slate-600">
              {lines.map((_, i) => (
                <li key={i} className="tabular-nums">{i + 1}</li>
              ))}
            </ol>
            {/* Each source line is its own element; content is plain TEXT children, so React
                escapes it — a file containing <script> renders as literal source, never a node. */}
            <pre className="flex-1 overflow-x-auto px-3 py-2 text-slate-200">
              {lines.map((line, i) => (
                <code key={i} className="block min-h-[1.25rem] whitespace-pre">{line}</code>
              ))}
            </pre>
          </div>
        </div>
      </div>
    </div>
  )
}
