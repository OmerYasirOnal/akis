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
    // A critical finding is a failure.
    const critical = viewWith({ status: 'running', codeReview: { approved: false, findings: 1, critical: true, iteration: 2 } },
      [{ agent: 'critic', done: true, ok: true, tools: [], notes: [] }])
    expect(step(critical, 'review').status).toBe('failed')
  })
})
