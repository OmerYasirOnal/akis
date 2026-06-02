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

  return ORDER.map(({ key, role }): PipelineStep => {
    let status = fromPresence(view, role)
    let stat: string | undefined
    let action: PipelineAction | undefined

    switch (key) {
      case 'spec':
        if (spec === 'awaiting') { status = 'awaiting'; action = 'approve'; stat = 'spec ready' }
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
          else if (cr.approved && cr.findings === 0) { status = 'done'; stat = 'review clean' }
          else { status = status === 'failed' ? 'failed' : 'done'; stat = `${cr.findings} findings` }
        } else if (status === 'active') stat = 'reviewing'
        break
      case 'verify':
        if (tests.ran) {
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

    return { key, role, status, ...(stat !== undefined ? { stat } : {}), ...(action !== undefined ? { action } : {}) }
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
