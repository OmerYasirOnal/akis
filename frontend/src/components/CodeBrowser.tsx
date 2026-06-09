import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeArtifact } from '@akis/shared'
import { useI18n } from '../i18n/I18nContext.js'
import { CopyButton } from './CopyButton.js'
import { useTreeResizable, clampTreeRatio } from './useTreeResizable.js'

type CodeFile = CodeArtifact['files'][number]

/** Fill {n}/… placeholders in a catalog template (same idiom as PreviewDrawer). */
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)

/** Map a file extension → a short uppercase language label for the editor header (subtle, best-effort).
 *  Unknown extensions yield '' (no badge) — never a guess. */
function langOf(filePath: string): string {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const map: Record<string, string> = {
    ts: 'TS', tsx: 'TSX', js: 'JS', jsx: 'JSX', mjs: 'JS', cjs: 'JS',
    json: 'JSON', css: 'CSS', scss: 'SCSS', html: 'HTML', md: 'MD',
    py: 'PY', go: 'GO', rs: 'RS', sh: 'SH', yml: 'YAML', yaml: 'YAML', sql: 'SQL', toml: 'TOML',
  }
  return (filePath.includes('.') && map[ext]) || ''
}

/**
 * Read-only browser for the code the agents wrote (SessionState.code.files). A file TREE on the
 * left (sorted by path) and a viewer on the right that shows the SELECTED file's content in a
 * monospace `<pre>` with a line-number gutter.
 *
 * RESIZABLE TREE (P2.2): the tree↔editor boundary is a `role="separator"` splitter (pointer drag +
 * keyboard Arrow/Home/End) wired to `useTreeResizable` — the SAME pointer-capture + rAF + persisted-
 * ratio idiom proven on the chat↔drawer seam, but with the tree's own clamp (12rem floor / 50% cap)
 * and its own localStorage key. The editor pane is `flex-1 min-w-0` so long lines SCROLL inside it
 * rather than pushing the tree wider (the empty-margin bug). The drag math (clientX → ratio) lives
 * here in the consumer, mirroring how ChatStudio owns the drawer's drag math.
 *
 * NO-XSS: file `content` and `filePath` are rendered as plain TEXT (React auto-escapes children) —
 * never dangerouslySetInnerHTML — so an agent-written file containing `<script>` shows up as literal
 * source, never as an injected/executed node. No syntax highlighting dep keeps the bundle lean.
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

  // The whole artifact as fenced blocks (one per file, path-labelled), so the user can lift the
  // entire app out in one copy — e.g. to paste into another tool. Stable per file list (memoized).
  const allFenced = useMemo(
    () => sorted.map(f => `\`\`\`${f.filePath}\n${f.content}\n\`\`\``).join('\n\n'),
    [sorted],
  )

  // Measure the split container read-only via a ResizeObserver — one setState per resize (no per-frame
  // React storm), feeding the tree splitter's clamp (px floor / 50% cap) like PreviewPanel's paneWidth.
  const splitRef = useRef<HTMLDivElement | null>(null)
  const [splitWidth, setSplitWidth] = useState(0)
  useEffect(() => {
    const el = splitRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width
      if (typeof w === 'number') setSplitWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { ratio, commitRatio, setRatioLive, onKeyDown } = useTreeResizable({ containerWidth: splitWidth })
  const pct = Math.round(clampTreeRatio(ratio, splitWidth) * 100)

  // --- Pointer-drag plumbing (mirrors PreviewDrawer): capture on the STABLE handle node so the drag
  // survives the cursor crossing the editor's scroll area; rAF-throttle moves (one DOM read per frame,
  // SSE-perf parity); map the live clientX → ratio against the measured container. `setRatioLive` writes
  // the un-persisted live ratio during the drag; `commitRatio` persists (clamped) on release.
  const handleRef = useRef<HTMLDivElement>(null)
  const latestX = useRef(0)
  const raf = useRef<number | null>(null)
  const dragging = useRef(false)

  const ratioFromClientX = useCallback((clientX: number): number => {
    const el = splitRef.current
    if (!el) return ratio
    const rect = el.getBoundingClientRect()
    if (!rect.width) return ratio
    // The tree is on the LEFT, so its width = clientX − left.
    return clampTreeRatio((clientX - rect.left) / rect.width, rect.width)
  }, [ratio])

  const flush = useCallback(() => {
    raf.current = null
    if (dragging.current) setRatioLive(ratioFromClientX(latestX.current))
  }, [ratioFromClientX, setRatioLive])

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (!dragging.current) return
    latestX.current = e.clientX
    if (raf.current === null) raf.current = requestAnimationFrame(flush)
  }, [flush])

  const endDrag = useCallback((e: PointerEvent) => {
    if (!dragging.current) return
    dragging.current = false
    if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null }
    const node = handleRef.current
    if (node) {
      node.classList.remove('is-dragging')
      try { node.releasePointerCapture(e.pointerId) } catch { /* capture may already be gone */ }
    }
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
    commitRatio(ratioFromClientX(e.clientX))
  }, [commitRatio, ratioFromClientX, onPointerMove])

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragging.current = true
    latestX.current = e.clientX
    const node = handleRef.current
    if (node) {
      try { node.setPointerCapture(e.pointerId) } catch { /* non-fatal: doc listeners track it */ }
      node.classList.add('is-dragging')
    }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', endDrag)
  }, [onPointerMove, endDrag])

  // Defensive cleanup: if CodeBrowser unmounts mid-drag (tab switch / session reset), drop listeners + frame.
  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
  }, [onPointerMove, endDrag])

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
  const lang = active ? langOf(active.filePath) : ''

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">{t('code.title')}</h3>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded bg-white/[0.06] px-2 py-0.5 text-xs text-slate-400">
            {sorted.length} {t('code.files')}
          </span>
          {/* Copy every file as path-labelled fenced blocks — the whole artifact in one grab. */}
          <CopyButton text={allFenced} label={t('code.copyAll')} className="text-[10px]" />
        </div>
      </div>

      {/* Split shell — flex (not a fixed grid) so the separator can drive a fluid tree width. The tree
          takes a percentage width (the persisted, clamped ratio); the editor is `flex-1 min-w-0` so it
          reflows to fill and its long lines SCROLL rather than push the tree. `is-dragging` disables the
          width ease during a 1:1 pointer drag (mirrors the drawer). */}
      <div
        ref={splitRef}
        className="group/split flex min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-black/50"
      >
        {/* File tree (left) — its width is the clamped ratio of the measured container. */}
        <ul
          className="min-h-0 shrink-0 overflow-y-auto overflow-x-hidden py-1"
          style={{ width: `${pct}%` }}
          aria-label={t('code.title')}
        >
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

        {/* VERTICAL RESIZE SEPARATOR — keyboard splitter + pointer drag (capture on this stable node).
            GRAB FIX (owner feedback 2): the old 12px handle sat FLUSH between two overflow-auto panes with
            NO z-index, so each pane's scrollbar gutter straddled the seam and SWALLOWED the pointer — the
            divider couldn't be grabbed in a real browser (jsdom has no scrollbars, so it passed there).
            Now the handle (a) widens its hit-strip past 12px with `-mx-1` so it STRADDLES the seam and the
            grab zone clears both panes' scrollbar gutters, (b) is lifted ABOVE both flex children with
            `relative z-20` so neither pane can paint over it, and (c) keeps `cursor-col-resize` +
            `touch-action:none` + setPointerCapture (onPointerDown) so the drag survives the cursor crossing
            the editor. The visible hairline is 1.5px (was 1px) so the target also READS as grabbable. */}
        <div
          ref={handleRef}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={t('code.resize')}
          aria-valuenow={pct}
          aria-valuemin={Math.round((splitWidth ? clampTreeRatio(0, splitWidth) : 0) * 100)}
          aria-valuemax={Math.round((splitWidth ? clampTreeRatio(1, splitWidth) : 50) * 100)}
          aria-valuetext={fill(t('code.resizeValue'), { n: String(pct) })}
          title={t('code.resizeHint')}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          style={{ touchAction: 'none' }}
          className="group/handle relative z-20 -mx-1 flex w-4 shrink-0 cursor-col-resize touch-none select-none items-center justify-center self-stretch focus:outline-none"
        >
          <span
            aria-hidden="true"
            className="h-full w-0.5 rounded-full bg-white/10 motion-safe:transition-all group-hover/handle:bg-[#07D1AF]/60 group-focus-visible/handle:w-0.5 group-focus-visible/handle:bg-[#07D1AF] group-focus-visible/handle:shadow-[0_0_6px_rgba(7,209,175,0.7)]"
          />
        </div>

        {/* Viewer (right): line-number gutter + monospace source. `min-w-0` lets long lines scroll
            inside this pane instead of pushing the tree. content is rendered as TEXT. */}
        <div data-testid="code-editor-pane" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-2.5 py-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[11px] text-slate-400">{active?.filePath}</span>
              {/* Subtle language badge for the active file (best-effort; hidden for unknown types). */}
              {lang && (
                <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-slate-500">
                  {lang}
                </span>
              )}
            </span>
            <div className="flex shrink-0 items-center gap-2 pl-2">
              <span className="text-[10px] text-slate-600">{lines.length} {t('code.lines')}</span>
              {/* `active &&` guards noUncheckedIndexedAccess (active is CodeFile | undefined). */}
              {active && <CopyButton text={active.content} label={t('copy.file')} className="text-[10px]" />}
            </div>
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
