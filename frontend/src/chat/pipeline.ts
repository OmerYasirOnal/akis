import type { Role } from '@akis/shared'
import type { SessionView } from '../live/types.js'
import { presenceOf } from '../components/AgentRoster.js'

/** The five fixed stages of an AKIS run, in pipeline order. */
export type PipelineStepKey = 'spec' | 'build' | 'review' | 'verify' | 'ship'

/** A step's live status. `awaiting` = a human gate is open and the user must act. */
export type PipelineStatus = 'pending' | 'active' | 'done' | 'awaiting' | 'failed'

/** The gate action a step can surface (wired to ChatStudio's onApprove/onConfirm). */
export type PipelineAction = 'approve' | 'confirm'

/**
 * A RECOVERY action a step surfaces when the run parked in a recoverable (non-gate) state,
 * so a stalled run is an actionable card — not a silent amber dot the user can't leave.
 * NOT a structural gate: acting on it never bypasses verify/push (the backend re-runs real
 * verification and the spec/push gates still apply).
 *   - 'critic_resolution': proceed (continue) | abandon (cancel) past the automatic critic.
 *   - 'verify_failed': retry — re-run REAL verification.
 */
export type PipelineRecovery = 'critic_resolution' | 'verify_failed'

/**
 * One stage card in the compact run pipeline. `stat` is a single human key-fact
 * (e.g. "2 tests", "review clean", a provider name) — undefined while pending.
 * `action` is set only when a human gate is open on that step.
 */
export interface PipelineStep {
  key: PipelineStepKey
  role: Role
  status: PipelineStatus
  /** One short summary stat for the step, or undefined while pending. */
  stat?: string
  /** When awaiting a human gate, the action to surface (approve | confirm). */
  action?: PipelineAction
  /** When the run parked in a recoverable (non-gate) state, the recovery to surface. */
  recovery?: PipelineRecovery
}

const ORDER: { key: PipelineStepKey; role: Role }[] = [
  { key: 'spec', role: 'scribe' },
  { key: 'build', role: 'proto' },
  { key: 'review', role: 'critic' },
  { key: 'verify', role: 'trace' },
  { key: 'ship', role: 'orchestrator' },
]

/** Map an agent's roster presence to a base pipeline status (no gate/stat overlay). */
function fromPresence(view: SessionView, role: Role): PipelineStatus {
  switch (presenceOf(view, role)) {
    case 'working': return 'active'
    case 'done': return 'done'
    case 'failed': return 'failed'
    default: return 'pending'
  }
}

/**
 * Derive the 5-step run pipeline from a SessionView — a PURE projection (same input →
 * same output), so it is unit-testable in isolation. Each step's status comes from the
 * relevant agent's live presence, overlaid with the structural truth that matters for
 * that stage: the spec/push human gates (which can sit AWAITING), the critic verdict
 * (a critical finding fails review), the verify test count, and the terminal run state.
 */
export function derivePipeline(view: SessionView): PipelineStep[] {
  const spec = view.gates.specApproval?.state
  const push = view.gates.pushConfirm?.state
  const cr = view.codeReview
  const tests = view.tests
  // Recoverable (non-gate) parks, surfaced as ACTION cards (not silent amber dots).
  const criticAwaiting = view.recovery?.critic === 'awaiting'
  const retryAwaiting = view.verifyFailed?.retry === 'awaiting'

  return ORDER.map(({ key, role }): PipelineStep => {
    let status = fromPresence(view, role)
    let stat: string | undefined
    let action: PipelineAction | undefined
    let recovery: PipelineRecovery | undefined

    switch (key) {
      case 'spec':
        // A critic-resolution park with NO code review yet = parked at the SPEC step: surface
        // the proceed/abandon recovery HERE (the run never reached code), as an action card.
        if (criticAwaiting && !cr) { status = 'awaiting'; recovery = 'critic_resolution'; stat = 'critic rejected' }
        else if (spec === 'awaiting') { status = 'awaiting'; action = 'approve'; stat = 'spec ready' }
        else if (spec === 'rejected') { status = 'failed'; stat = 'spec rejected' }
        else if (spec === 'satisfied') { status = 'done'; stat = 'spec approved' }
        else if (status !== 'pending') stat = status === 'failed' ? 'spec failed' : 'spec ready'
        break
      case 'build':
        if (status === 'done') stat = 'code written'
        else if (status === 'active') stat = 'writing code'
        else if (status === 'failed') stat = 'build failed'
        break
      case 'review':
        if (cr) {
          if (cr.critical) { status = 'failed'; stat = 'critical finding' }
          // Approved (the normal flow ships with advisory findings) → done.
          else if (cr.approved) { status = 'done'; stat = cr.findings === 0 ? 'review clean' : `${cr.findings} findings` }
          // NOT approved AND the run parked at critic-resolution (code-step park): surface a
          // proceed/abandon recovery ACTION card (no longer a silent amber dot). The user can
          // proceed (continue to the REAL verify + push gates) or abandon (cancel).
          else if (criticAwaiting) { status = 'awaiting'; recovery = 'critic_resolution'; stat = cr.findings > 0 ? `${cr.findings} findings` : 'critic rejected' }
          // NOT approved with no live recovery signal (e.g. mid-iterate) → amber, no action.
          else if (status !== 'failed') { status = 'awaiting'; stat = cr.findings > 0 ? `${cr.findings} findings` : undefined }
        } else if (status === 'active') stat = 'reviewing'
        break
      case 'verify':
        // A retryable verify failure is an ACTION card (retry re-runs REAL verification) —
        // not a silent dead-end. It takes precedence over the raw presence-derived status.
        if (retryAwaiting) {
          status = 'failed'; recovery = 'verify_failed'
          stat = tests.ran ? `${tests.testsRun} tests` : 'verify failed'
        } else if (tests.ran) {
          status = tests.passed ? 'done' : 'failed'
          stat = `${tests.testsRun} tests`
        } else if (status === 'active') stat = 'running tests'
        else if (status === 'failed') stat = 'verify failed'
        break
      case 'ship':
        // Ship is the terminal stage: the orchestrator is "working" for the whole run,
        // so don't treat that as ship being active — it only goes active/awaiting once
        // the work is actually done (verified / push gate open / terminal state).
        if (push === 'awaiting') { status = 'awaiting'; action = 'confirm'; stat = 'ready to ship' }
        else if (view.status === 'done') { status = 'done'; stat = view.provider ?? 'shipped' }
        else if (view.status === 'failed') { status = 'failed'; stat = 'run failed' }
        else if (push === 'satisfied') { status = 'done'; stat = view.provider ?? 'shipped' }
        else if (view.verified) { status = 'active'; stat = 'finishing' }
        else status = 'pending'
        break
    }

    return { key, role, status, ...(stat !== undefined ? { stat } : {}), ...(action !== undefined ? { action } : {}), ...(recovery !== undefined ? { recovery } : {}) }
  })
}

/**
 * A one-line summary of a finished/terminal run, e.g.
 * "✓ Verified · 2 tests · review clean · shipped". Returns undefined when the run is not
 * in a state worth summarising (still in-flight with nothing notable). Pure.
 */
export function summarizePipeline(view: SessionView): string | undefined {
  const parts: string[] = []
  if (view.status === 'failed') return '✗ Run failed'
  if (view.tests.ran) parts.push(view.tests.passed ? '✓ Verified' : '✗ Not verified', `${view.tests.testsRun} tests`)
  if (view.codeReview) {
    parts.push(view.codeReview.critical ? 'critical finding'
      : view.codeReview.approved && view.codeReview.findings === 0 ? 'review clean'
      : `${view.codeReview.findings} findings`)
  }
  if (view.status === 'done') parts.push(view.provider ? `shipped · ${view.provider}` : 'shipped')
  return parts.length ? parts.join(' · ') : undefined
}
