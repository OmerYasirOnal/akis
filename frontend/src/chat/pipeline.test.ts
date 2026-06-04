import { describe, it, expect } from 'vitest'
import { derivePipeline, type PipelineStepKey } from './pipeline.js'
import { emptyView } from '../live/viewModel.js'
import type { SessionView, AgentLane } from '../live/types.js'

/** Build a SessionView with a single 'main' lane of agent steps for terse fixtures. */
function viewWith(partial: Partial<SessionView>, steps: AgentLane['steps'] = []): SessionView {
  const base = emptyView('s1')
  const lanes: AgentLane[] = steps.length ? [{ laneId: 'main', steps }] : base.lanes
  return { ...base, ...partial, lanes: partial.lanes ?? lanes }
}

/** Pull a step out of the derived pipeline by its stable key. */
function step(view: SessionView, key: PipelineStepKey) {
  const s = derivePipeline(view).find(x => x.key === key)
  if (!s) throw new Error(`no step ${key}`)
  return s
}

describe('derivePipeline', () => {
  it('returns the 5 pipeline steps in order', () => {
    const p = derivePipeline(emptyView('s1'))
    expect(p.map(s => s.key)).toEqual(['spec', 'build', 'review', 'verify', 'ship'])
    expect(p.map(s => s.role)).toEqual(['scribe', 'proto', 'critic', 'trace', 'orchestrator'])
  })

  // (a) a fresh/awaiting-spec session: spec gate awaiting, nothing else started.
  it('(a) awaiting spec → spec is awaiting, rest pending', () => {
    const view = viewWith({ status: 'running', gates: { specApproval: { gate: 'spec_approval', state: 'awaiting' } } },
      [{ agent: 'scribe', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'spec').status).toBe('awaiting')
    expect(step(view, 'build').status).toBe('pending')
    expect(step(view, 'review').status).toBe('pending')
    expect(step(view, 'verify').status).toBe('pending')
    expect(step(view, 'ship').status).toBe('pending')
    expect(step(view, 'spec').stat).toBe('spec ready')
  })

  // (b) mid-build: spec approved, proto working, no review/verify yet.
  it('(b) mid-build → spec done, build active', () => {
    const view = viewWith({ status: 'running', gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' } } },
      [{ agent: 'scribe', done: true, ok: true, tools: [], notes: [] }, { agent: 'proto', done: false, tools: [], notes: [] }])
    expect(step(view, 'spec').status).toBe('done')
    expect(step(view, 'spec').stat).toBe('spec approved')
    expect(step(view, 'build').status).toBe('active')
    expect(step(view, 'review').status).toBe('pending')
  })

  // (c) done + verified + shipped: every step done with its summary stat.
  it('(c) done+verified → all steps done, ship shows provider', () => {
    const view = viewWith({
      status: 'done', verified: true, provider: 'anthropic',
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'satisfied' } },
      tests: { testsRun: 2, passed: true, ran: true },
      codeReview: { approved: true, findings: 0, critical: false, iteration: 1 },
    }, [
      { agent: 'scribe', done: true, ok: true, tools: [], notes: [] },
      { agent: 'proto', done: true, ok: true, tools: [], notes: [] },
      { agent: 'critic', done: true, ok: true, tools: [], notes: [] },
      { agent: 'trace', done: true, ok: true, tools: [], notes: [] },
    ])
    expect(step(view, 'spec').status).toBe('done')
    expect(step(view, 'build').status).toBe('done')
    expect(step(view, 'review').status).toBe('done')
    expect(step(view, 'review').stat).toBe('review clean')
    expect(step(view, 'verify').status).toBe('done')
    expect(step(view, 'verify').stat).toBe('2 tests')
    expect(step(view, 'ship').status).toBe('done')
    expect(step(view, 'ship').stat).toBe('anthropic')
  })

  // (d) a failed run: the failing agent's step shows failed, ship shows failed.
  it('(d) failed run → failing build step is failed, ship failed', () => {
    const view = viewWith({ status: 'failed' }, [
      { agent: 'scribe', done: true, ok: true, tools: [], notes: [] },
      { agent: 'proto', done: true, ok: false, tools: [], notes: [] },
    ])
    expect(step(view, 'build').status).toBe('failed')
    expect(step(view, 'ship').status).toBe('failed')
  })

  // (e) a gate awaiting (push confirm): ship surfaces an awaiting state + the confirm action key.
  it('(e) push gate awaiting → ship awaiting with confirm action', () => {
    const view = viewWith({
      status: 'running', verified: true,
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'awaiting' } },
      tests: { testsRun: 1, passed: true, ran: true },
    }, [
      { agent: 'scribe', done: true, ok: true, tools: [], notes: [] },
      { agent: 'proto', done: true, ok: true, tools: [], notes: [] },
      { agent: 'trace', done: true, ok: true, tools: [], notes: [] },
    ])
    expect(step(view, 'ship').status).toBe('awaiting')
    expect(step(view, 'ship').action).toBe('confirm')
  })

  it('surfaces the spec-approval action on the spec step when awaiting', () => {
    const view = viewWith({ status: 'running', gates: { specApproval: { gate: 'spec_approval', state: 'awaiting' } } })
    expect(step(view, 'spec').action).toBe('approve')
    // no awaiting elsewhere → no stray actions
    expect(step(view, 'ship').action).toBeUndefined()
  })

  it('review: approved-with-findings is done (advisory); NOT-approved is amber awaiting, not falsely done', () => {
    // The normal flow ships with advisory findings → approved:true → done (green).
    const advisory = viewWith({ status: 'running', codeReview: { approved: true, findings: 3, critical: false, iteration: 1 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(advisory, 'review').status).toBe('done')
    expect(step(advisory, 'review').stat).toBe('3 findings')
    // A critic that did NOT approve (run parked at awaiting_critic_resolution) must surface as
    // amber 'awaiting', NEVER a green 'done' that hides a stalled build.
    const notApproved = viewWith({ status: 'running', codeReview: { approved: false, findings: 3, critical: false, iteration: 1 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(notApproved, 'review').status).toBe('awaiting')
    expect(step(notApproved, 'review').stat).toBe('3 findings')
    // A critical finding on a run that did NOT proceed (no tests ran, still running) is a red failure.
    const critical = viewWith({ status: 'running', codeReview: { approved: false, findings: 1, critical: true, iteration: 2 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(critical, 'review').status).toBe('failed')
  })

  it('review: a critical finding the user PROCEEDED past is an amber CAUTION (visible, not hidden), not red', () => {
    // The user proceeded and the run moved on to REAL verification → caution, never a red failure
    // (the build shipped) and never a green done (the critical finding stays VISIBLE — trust).
    const proceededVerified = viewWith({
      status: 'running',
      codeReview: { approved: false, findings: 1, critical: true, iteration: 2 },
      tests: { testsRun: 2, passed: true, ran: true },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(proceededVerified, 'review').status).toBe('caution')
    expect(step(proceededVerified, 'review').stat).toBe('critical proceeded')
    // Same on a fully-done run (proceeded → shipped) even if tests didn't run.
    const proceededShipped = viewWith({
      status: 'done',
      codeReview: { approved: false, findings: 1, critical: true, iteration: 2 },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(proceededShipped, 'review').status).toBe('caution')
    expect(step(proceededShipped, 'review').stat).toBe('critical proceeded')
    // Branch ORDER lock: an UNRESOLVED critical (parked at critic-resolution) is still the
    // actionable awaiting recovery, NOT caution — caution must not swallow a live park.
    const parkedCritical = viewWith({
      status: 'running',
      codeReview: { approved: false, findings: 1, critical: true, iteration: 2 },
      recovery: { critic: 'awaiting' },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(parkedCritical, 'review').status).toBe('awaiting')
    expect(step(parkedCritical, 'review').recovery).toBe('critic_resolution')
  })

  // ── Run-state recovery: a parked run surfaces an ACTION (recovery), not a silent dot. ──
  it('critic-resolution at the CODE step → review step carries a critic_resolution recovery action', () => {
    const view = viewWith({
      status: 'running',
      codeReview: { approved: false, findings: 2, critical: false, iteration: 1 },
      recovery: { critic: 'awaiting' },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'review').status).toBe('awaiting')
    expect(step(view, 'review').recovery).toBe('critic_resolution')
  })

  it('critic-resolution at the SPEC step (no code review yet) → spec step carries the recovery action', () => {
    const view = viewWith({ status: 'running', recovery: { critic: 'awaiting' } })
    expect(step(view, 'spec').status).toBe('awaiting')
    expect(step(view, 'spec').recovery).toBe('critic_resolution')
    expect(step(view, 'review').recovery).toBeUndefined()
  })

  it('a RESOLVED critic-resolution no longer surfaces an action', () => {
    const view = viewWith({ status: 'running', recovery: { critic: 'resolved' }, codeReview: { approved: false, findings: 1, critical: false, iteration: 1 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'review').recovery).toBeUndefined()
  })

  it('verify_failed → verify step is failed and carries a verify_failed retry action', () => {
    const view = viewWith({
      status: 'running',
      tests: { testsRun: 3, passed: false, ran: true },
      verifyFailed: { retry: 'awaiting' },
    }, [{ agent: 'trace', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'verify').status).toBe('failed')
    expect(step(view, 'verify').recovery).toBe('verify_failed')
    expect(step(view, 'verify').stat).toBe('3 tests')
  })

  it('a RESOLVED verify_failed no longer surfaces a retry action', () => {
    const view = viewWith({ status: 'running', tests: { testsRun: 3, passed: false, ran: true }, verifyFailed: { retry: 'resolved' } },
      [{ agent: 'trace', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'verify').recovery).toBeUndefined()
  })

  // ── push_failed: a verified run whose push failed surfaces a retry on the SHIP step. ──
  it('push_failed → ship step is failed and carries a push_failed retry action (routes through confirm)', () => {
    const view = viewWith({
      status: 'running', verified: true,
      gates: { specApproval: { gate: 'spec_approval', state: 'satisfied' }, pushConfirm: { gate: 'push_confirm', state: 'awaiting' } },
      tests: { testsRun: 2, passed: true, ran: true },
      pushFailed: { retry: 'awaiting' },
    }, [{ agent: 'trace', done: true, ok: true, tools: [], notes: [] }])
    const ship = step(view, 'ship')
    expect(ship.status).toBe('failed')
    expect(ship.recovery).toBe('push_failed')
    expect(ship.stat).toBe('push failed')
    // The retry reuses the existing confirm action — still gated by Gate 4 on the backend.
    expect(ship.action).toBe('confirm')
  })

  it('a RESOLVED push_failed no longer surfaces a retry action (push later succeeded)', () => {
    const view = viewWith({ status: 'done', verified: true, pushFailed: { retry: 'resolved' } })
    expect(step(view, 'ship').recovery).toBeUndefined()
  })

  // ── #79 LOW: a CRITICAL critic park must ALSO be an actionable recovery, not a dead failed dot. ──
  it('critical-finding critic park → review carries a critic_resolution recovery action (proceed/abandon)', () => {
    const view = viewWith({
      status: 'running',
      codeReview: { approved: false, findings: 1, critical: true, iteration: 2 },
      recovery: { critic: 'awaiting' },
    }, [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    const review = step(view, 'review')
    expect(review.status).toBe('awaiting')                 // not a silent dead-end 'failed'
    expect(review.recovery).toBe('critic_resolution')      // proceed/abandon now surfaces
    expect(review.stat).toBe('critical finding')
  })

  it('a critical finding with NO live recovery signal stays a plain failed (no stray action)', () => {
    const view = viewWith({ status: 'running', codeReview: { approved: false, findings: 1, critical: true, iteration: 2 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'review').status).toBe('failed')
    expect(step(view, 'review').recovery).toBeUndefined()
  })

  it('a RESOLVED critical critic park no longer surfaces an action', () => {
    const view = viewWith({ status: 'running', recovery: { critic: 'resolved' }, codeReview: { approved: false, findings: 1, critical: true, iteration: 2 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(view, 'review').recovery).toBeUndefined()
  })
})
