import { useState, useEffect, useCallback, useRef } from 'react'
import type { ApiClient, ExternalWriteSummary } from '../api/client.js'
import { useI18n } from '../i18n/I18nContext.js'
import type { StringKey } from '../i18n/catalog.js'
import { SectionTitle, Button, Input, ErrorNote } from '../ui/kit.js'
import { ApiError } from '../api/client.js'

/**
 * AGENT-PROPOSED GitHub writes — a CONFIRM-ONLY surface (distinct from ExternalWriteCard, which is the
 * user-initiated propose→confirm form). A build agent recorded these via `propose_github_write`; each is
 * already a `status:'proposed'` ExternalWriteRecord. This component lets a HUMAN read the EXACT bound
 * content and confirm (which executes via the gate) — AKIS is strictly on the propose side; the FE holds
 * no gate authority (confirm just posts the stored digest the server bound).
 *
 * GATE-SAFETY: Confirm calls ONLY the bare `api.confirmExternalWrite(sessionId, id, digest)` with the
 * record's OWN server-computed digest — it mints NOTHING client-side. The classifier below is ADVISORY
 * UX (it drives banners + the typed-merge friction); the digest already binds the exact merge_method/
 * state, so no friction here is a security primitive — it is legibility (§5.4).
 *
 * UI FAITHFULNESS (§5.2): a human can't read a SHA-256, so the card renders the STRUCTURED target/payload
 * the digest was computed over (per-action fields, not a raw dump) PLUS a collapsible exact-bytes view —
 * so what is shown == what is bound == what executes. We only render fields that are actually present in
 * target/payload, so the card never shows a field the digest doesn't bind.
 */

/** Live MCP tool name → logical action, refined by payload (open vs close vs merge are the same `action`
 *  with different payload keys, so the card must read BOTH). Pure, so it is unit-testable in isolation. */
type ActionKind =
  | 'openIssue' | 'closeIssue' | 'comment'
  | 'openPr' | 'closePr' | 'editPr' | 'mergePr' | 'syncBranch' | 'requestReview'
  | 'reviewApprove' | 'reviewRequestChanges' | 'reviewComment'
  | 'write'

/** The destructiveness class the FE friction keys on (§5.4) — advisory UX, NOT a gate. */
export type WriteRisk = 'reversible' | 'destructive' | 'irreversible'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** Read a #issue/#PR number whether the producer sent it as a number or a numeric string. */
function numLike(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return undefined
}

/** The PR number lives on `target` for PR tools (camelCase `pullNumber`); an issue/PR comment carries it
 *  as snake_case `issue_number`. Naming is load-bearing + inconsistent (the gate passes args verbatim). */
function prNumber(w: ExternalWriteSummary): number | undefined { return numLike(w.target.pullNumber) }
function issueNumber(w: ExternalWriteSummary): number | undefined { return numLike(w.target.issue_number) }

/** Derive the human-facing action from the tool name refined by payload discriminators (method/state/
 *  event). Mirrors the catalog in the design doc §2; defaults to a generic 'write' for anything unmapped. */
export function classifyGithubAction(action: string, payload: Record<string, unknown>): ActionKind {
  const method = str(payload.method)
  const state = str(payload.state)
  switch (action) {
    case 'issue_write':
      if (method === 'create') return 'openIssue'
      if (state === 'closed') return 'closeIssue'
      return 'write' // issue update (label/triage) — generic, no destructive class
    case 'add_issue_comment':
      return 'comment'
    case 'create_pull_request':
      return 'openPr'
    case 'update_pull_request':
      if (state === 'closed') return 'closePr'
      if (Array.isArray(payload.reviewers)) return 'requestReview'
      return 'editPr'
    case 'merge_pull_request':
      return 'mergePr'
    case 'update_pull_request_branch':
      return 'syncBranch'
    case 'pull_request_review_write': {
      const event = str(payload.event)
      if (event === 'APPROVE') return 'reviewApprove'
      if (event === 'REQUEST_CHANGES') return 'reviewRequestChanges'
      return 'reviewComment'
    }
    default:
      return 'write'
  }
}

/** Destructiveness class (§5.4) — keyed on PAYLOAD, since the action alone can't tell open-PR from
 *  merge-PR. Advisory UX only (banners + typed-merge friction); the digest binds the real bytes. */
export function classifyGithubRisk(action: string, payload: Record<string, unknown>): WriteRisk {
  if (action === 'merge_pull_request') return 'irreversible'
  if ((action === 'issue_write' || action === 'update_pull_request') && str(payload.state) === 'closed') return 'destructive'
  if (action === 'pull_request_review_write' && (str(payload.event) === 'APPROVE' || str(payload.method) === 'resolve_thread')) return 'destructive'
  return 'reversible'
}

const ACTION_KEY: Record<ActionKind, StringKey> = {
  openIssue: 'aw.act.openIssue', closeIssue: 'aw.act.closeIssue', comment: 'aw.act.comment',
  openPr: 'aw.act.openPr', closePr: 'aw.act.closePr', editPr: 'aw.act.editPr', mergePr: 'aw.act.mergePr',
  syncBranch: 'aw.act.syncBranch', requestReview: 'aw.act.requestReview',
  reviewApprove: 'aw.act.reviewApprove', reviewRequestChanges: 'aw.act.reviewRequestChanges', reviewComment: 'aw.act.reviewComment',
  write: 'aw.act.write',
}

/** One structured field row to render — label key + the already-stringified value (we never JSON-dump). */
interface FieldRow { label: StringKey; value: string }

/** Truncate a long body/title preview so the card stays readable; the exact-bytes drawer shows it whole. */
const preview = (v: unknown, n = 240): string | undefined => { const s = str(v); return s === undefined ? undefined : (s.length > n ? `${s.slice(0, n)}…` : s) }

/** Extract the per-action structured rows from target+payload — ONLY fields actually present, so the card
 *  never shows a field the digest doesn't bind. The repo (owner/repo) is rendered separately. */
function structuredFields(w: ExternalWriteSummary): FieldRow[] {
  const rows: FieldRow[] = []
  const push = (label: StringKey, value: string | undefined): void => { if (value !== undefined && value !== '') rows.push({ label, value }) }
  const p = w.payload
  const issue = issueNumber(w)
  const pr = prNumber(w)
  if (issue !== undefined) push('aw.f.issue', `#${issue}`)
  if (pr !== undefined) push('aw.f.pr', `#${pr}`)
  push('aw.f.method', str(p.method))
  push('aw.f.state', str(p.state))
  push('aw.f.stateReason', str(p.state_reason))
  push('aw.f.event', str(p.event))
  push('aw.f.head', str(p.head))
  push('aw.f.base', str(p.base))
  push('aw.f.mergeMethod', str(p.merge_method))
  if (Array.isArray(p.labels) && p.labels.length > 0) push('aw.f.labels', p.labels.filter((x): x is string => typeof x === 'string').join(', '))
  if (Array.isArray(p.reviewers) && p.reviewers.length > 0) push('aw.f.reviewers', p.reviewers.filter((x): x is string => typeof x === 'string').join(', '))
  push('aw.f.title', preview(p.title, 120))
  push('aw.f.body', preview(p.body))
  return rows
}

/** owner/repo as a single readable "owner/repo" string when both are present. */
function repoString(target: Record<string, unknown>): string | undefined {
  const owner = str(target.owner); const repo = str(target.repo)
  return owner && repo ? `${owner}/${repo}` : (repo ?? owner)
}

/** Fill {n}/{base} placeholders in a banner string (the catalog carries the template). */
const fill = (s: string, vars: Record<string, string>): string => s.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m)

/** A colored pill for a review event (APPROVE green / REQUEST_CHANGES rose / COMMENT slate). */
function eventPill(event: string): { cls: string } {
  if (event === 'APPROVE') return { cls: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30' }
  if (event === 'REQUEST_CHANGES') return { cls: 'bg-rose-400/15 text-rose-300 border-rose-400/30' }
  return { cls: 'bg-white/10 text-slate-300 border-white/20' }
}

/** A single confirm card for one proposed agent write. */
function ProposalCard({ w, sessionId, api, onResolved }: { w: ExternalWriteSummary; sessionId: string; api: ApiClient; onResolved: (id: string) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | undefined>()
  const [done, setDone] = useState<{ ok: boolean; result: string } | undefined>()
  const [showBytes, setShowBytes] = useState(false)
  const [typed, setTyped] = useState('') // the typed-merge confirmation echo

  const kind = classifyGithubAction(w.action, w.payload)
  const risk = classifyGithubRisk(w.action, w.payload)
  const fields = structuredFields(w)
  const repo = repoString(w.target)
  const pr = prNumber(w)
  const issue = issueNumber(w)
  const event = str(w.payload.event)

  // MERGE FRICTION (§5.4): an irreversible merge stays disabled until the user TYPES the PR number,
  // echoing the literal pullNumber the digest binds. With no pullNumber present we cannot demand an
  // echo, so we fall back to keeping the strong banner but not blocking (the digest still binds the args).
  const needsTypedConfirm = risk === 'irreversible' && pr !== undefined
  const typedOk = !needsTypedConfirm || typed.trim() === String(pr)

  const confirm = useCallback(async (): Promise<void> => {
    setBusy(true); setErr(undefined)
    try {
      // GATE-SAFE: confirm posts the record's OWN server-bound digest verbatim — nothing minted here.
      const r = await api.confirmExternalWrite(sessionId, w.id, w.digest)
      setDone({ ok: r.ok, result: r.result ?? (r.ok ? 'done' : 'failed') })
    } catch (e) { setErr(ApiError.is(e) ? e.message : String(e)) }
    finally { setBusy(false) }
  }, [api, sessionId, w.id, w.digest])

  if (done) {
    return (
      <div role="status" className={`rounded-xl border px-3 py-2 text-sm ${done.ok ? 'border-[#07D1AF]/30 bg-[#07D1AF]/10 text-[#07D1AF]' : 'border-rose-400/30 bg-rose-400/10 text-rose-300'}`}>
        {done.ok ? t('aw.done.ok') : t('aw.done.failed')}: {done.result.slice(0, 200)}
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
      {/* HEADER: summary + GitHub badge + action chip. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-300">{t('aw.badge.github')}</span>
        <span className="rounded bg-violet-400/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-200">{t(ACTION_KEY[kind])}</span>
        {event && (kind === 'reviewApprove' || kind === 'reviewRequestChanges' || kind === 'reviewComment') && (
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${eventPill(event).cls}`}>{event}</span>
        )}
      </div>
      <div className="mb-2 text-sm text-slate-200">{w.summary}</div>

      {err && <div className="my-2"><ErrorNote>{err}</ErrorNote></div>}

      {/* FRICTION BANNERS (§5.4) — advisory; the digest already binds merge_method/state. */}
      {risk === 'irreversible' && (
        <div role="alert" className="mb-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-200">
          {pr !== undefined
            ? fill(t('aw.banner.merge'), { n: String(pr), base: str(w.payload.base) ?? str(w.target.base) ?? 'main' })
            : fill(t('aw.banner.mergeNoBase'), { n: '?' })}
        </div>
      )}
      {risk === 'destructive' && kind === 'closeIssue' && (
        <div role="alert" className="mb-2 rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-300">{fill(t('aw.banner.closeIssue'), { n: issue !== undefined ? String(issue) : '?' })}</div>
      )}
      {risk === 'destructive' && kind === 'closePr' && (
        <div role="alert" className="mb-2 rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-2 text-xs font-semibold text-rose-300">{fill(t('aw.banner.closePr'), { n: pr !== undefined ? String(pr) : '?' })}</div>
      )}
      {risk === 'destructive' && kind === 'reviewApprove' && (
        <div role="alert" className="mb-2 rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs font-semibold text-amber-200">{t('aw.banner.approve')}</div>
      )}

      {/* STRUCTURED target/payload — per-action fields, NEVER a raw JSON dump. Only present fields shown. */}
      <dl className="mb-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {repo !== undefined && (
          <>
            <dt className="text-slate-500">{t('aw.f.repo')}</dt>
            <dd className="min-w-0 break-words text-slate-300"><code>{repo}</code></dd>
          </>
        )}
        {fields.map((f, i) => (
          <div key={`${f.label}-${i}`} className="contents">
            <dt className="text-slate-500">{t(f.label)}</dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-slate-300">{f.value}</dd>
          </div>
        ))}
      </dl>

      {/* EXACT BYTES (collapsible) — the {target,payload} the digest binds + the digest prefix. */}
      <button type="button" onClick={() => setShowBytes(v => !v)} className="text-xs text-slate-500 underline hover:text-slate-300">
        {showBytes ? t('aw.hideBytes') : t('aw.showBytes')}
      </button>
      {showBytes && (
        <>
          <div className="mt-1 text-[11px] text-slate-500">{t('aw.exactBytes')}</div>
          <pre className="mt-1 max-h-48 overflow-auto rounded-lg border border-white/10 bg-black/30 p-2 text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">{JSON.stringify({ target: w.target, payload: w.payload }, null, 2)}</pre>
          <div className="mt-1 text-[11px] text-slate-500">{t('aw.digest')}: <code>{w.digest.slice(0, 16)}…</code></div>
        </>
      )}

      {/* MERGE typed-confirm input — Confirm is DISABLED until the typed PR number matches. */}
      {needsTypedConfirm && (
        <div className="mt-2 flex flex-col gap-1">
          <label className="text-xs text-amber-200">{fill(t('aw.merge.typeToConfirm'), { n: String(pr) })}</label>
          <Input value={typed} onChange={e => setTyped(e.target.value)} placeholder={t('aw.merge.placeholder')} inputMode="numeric" aria-label={fill(t('aw.merge.typeToConfirm'), { n: String(pr) })} />
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Button onClick={() => void confirm()} disabled={busy || !typedOk}>{busy ? t('aw.confirming') : t('aw.confirm')}</Button>
        <Button variant="ghost" onClick={() => onResolved(w.id)} disabled={busy}>{t('aw.dismiss')}</Button>
      </div>
    </div>
  )
}

/**
 * Lists the build's `status:'proposed'` GitHub agent writes and renders a confirm card for each. Polls
 * the list on an interval so a proposal surfaces LIVE as the agent emits the `propose_github_write`
 * tool_call during a build. Dismiss is an FE-only hide (the proposal stays on the server until confirmed).
 */
export function AgentWriteProposals({ sessionId, api, pollMs = 4000 }: { sessionId: string; api: ApiClient; pollMs?: number }) {
  const { t } = useI18n()
  const [writes, setWrites] = useState<ExternalWriteSummary[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set())
  // Keep the latest dismissed set readable inside the polling closure without re-arming the interval.
  const dismissedRef = useRef(dismissed)
  dismissedRef.current = dismissed

  const load = useCallback((): void => {
    // Promise.resolve().then so a synchronous throw (a partial mock / older api) becomes a handled
    // rejection — the surface degrades to empty, never crashes the build view.
    Promise.resolve().then(() => api.listExternalWrites(sessionId))
      .then(r => setWrites(Array.isArray(r?.writes) ? r.writes : []))
      .catch(() => {})
  }, [api, sessionId])

  useEffect(() => {
    load()
    const id = setInterval(load, pollMs)
    return () => clearInterval(id)
  }, [load, pollMs])

  const onResolved = useCallback((id: string): void => setDismissed(prev => new Set(prev).add(id)), [])

  // Only PROPOSED, GitHub-provider, not-yet-dismissed proposals get a confirm card. A confirmed/executed
  // write is carried by ExternalWriteCard's history, not duplicated here.
  const open = writes.filter(w => w.provider === 'github' && w.status === 'proposed' && !dismissed.has(w.id))
  if (open.length === 0) return null

  return (
    <div className="rounded-2xl border border-amber-400/20 bg-amber-400/[0.03] p-4">
      <SectionTitle sub={t('aw.sub')}>{t('aw.title')}</SectionTitle>
      <div className="flex flex-col gap-3">
        {open.map(w => <ProposalCard key={w.id} w={w} sessionId={sessionId} api={api} onResolved={onResolved} />)}
      </div>
    </div>
  )
}
