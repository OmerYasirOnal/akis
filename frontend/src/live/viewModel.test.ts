import { describe, it, expect } from 'vitest'
import { foldSessionView, emptyView } from './viewModel.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

describe('foldSessionView (pure live view-model)', () => {
  it('returns an empty view for no events', () => {
    const v = foldSessionView('s1', [])
    expect(v).toEqual(emptyView('s1'))
  })

  it('builds a per-agent step tree: agent_start -> tool_call/result -> agent_end', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }),
      ev({ kind: 'tool_call', tool: 'dispatch_scribe', args: { idea: 'todo' }, agent: 'scribe' }),
      ev({ kind: 'tool_result', tool: 'dispatch_scribe', ok: true, result: { title: 't' }, agent: 'scribe' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe' }),
    ]
    const v = foldSessionView('s1', events)
    const lane = v.lanes.find(l => l.laneId === 'main')!
    expect(lane.steps).toHaveLength(1)
    const step = lane.steps[0]!
    expect(step.agent).toBe('scribe')
    expect(step.done).toBe(true)
    expect(step.ok).toBe(true)
    expect(step.tools).toEqual([{ tool: 'dispatch_scribe', args: { idea: 'todo' }, ok: true, result: { title: 't' } }])
  })

  it('separates lanes (verify runs on its own lane)', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }),
    ]
    const v = foldSessionView('s1', events)
    expect(v.lanes.map(l => l.laneId).sort()).toEqual(['main', 'verify'])
  })

  it('folds gate states (last wins) and drives card state', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }),
      ev({ kind: 'gate', gate: 'spec_approval', state: 'satisfied' }),
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
    ]
    const v = foldSessionView('s1', events)
    expect(v.gates.specApproval).toEqual({ gate: 'spec_approval', state: 'satisfied' })
    expect(v.gates.pushConfirm).toEqual({ gate: 'push_confirm', state: 'awaiting' })
  })

  it('reads test stats from verify, preview url, errors, and done/provider', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'session', status: 'started' }),
      ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'preview', url: 'https://github.com/mock/s1' }),
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }),
      ev({ kind: 'tool_result', tool: 'dispatch_proto', ok: false, result: { error: 'boom' }, agent: 'proto' }),
      ev({ kind: 'error', message: 'push failed: x' }),
      ev({ kind: 'done', verified: true, provider: 'anthropic' }),
    ]
    const v = foldSessionView('s1', events)
    expect(v.tests).toMatchObject({ testsRun: 3, passed: true, ran: true })
    // A `preview` event is the SHIPPED artifact (a link), not the running app.
    expect(v.preview.artifactUrl).toBe('https://github.com/mock/s1')
    expect(v.preview.url).toBeUndefined()
    expect(v.errors.some(e => e.includes('boom'))).toBe(true)
    expect(v.errors.some(e => e.includes('push failed'))).toBe(true)
    expect(v.status).toBe('done')
    expect(v.provider).toBe('anthropic')
    expect(v.verified).toBe(true)
  })

  it('consumes preview_status (embeds the same-origin url on ready) and test_stats', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'starting' }),
      ev({ kind: 'test_stats', built: 4, running: 4, passed: 4, failed: 0, durationMs: 1200 }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
    ])
    expect(v.preview).toEqual({ ready: true, starting: false, stopped: false, url: '/preview/s1/' })
    expect(v.tests.ran).toBe(true)
    expect(v.tests.scenariosBuilt).toBe(4)
    expect(v.tests.scenariosRunning).toBe(4)
  })

  // P1-CORE-1: the optional `demo` annotation flows from the events into the view-model.
  it('folds the verify event demo flag into tests.demo (and omits it on a live verify)', () => {
    const live = foldSessionView('s1', [ev({ kind: 'verify', testsRun: 2, passed: true, agent: 'trace', laneId: 'verify' })])
    expect(live.tests.demo).toBeUndefined()
    const demo = foldSessionView('s1', [ev({ kind: 'verify', testsRun: 2, passed: true, demo: true, agent: 'trace', laneId: 'verify' })])
    expect(demo.tests.demo).toBe(true)
  })

  it('folds the preview_status demo flag into preview.demo, and it sticks across lifecycle frames', () => {
    const live = foldSessionView('s1', [ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' })])
    expect(live.preview.demo).toBeUndefined()
    const demo = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'starting', demo: true }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }), // a later frame w/o demo
    ])
    expect(demo.preview.demo).toBe(true) // sticks once seen
  })

  // Lane A: a preview-boot FAILURE is surfaced (with its human reason), never silently dropped.
  it('surfaces a preview_status failure with its reason, and a later starting clears it', () => {
    const failed = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'starting' }),
      ev({ kind: 'preview_status', status: 'failed', reason: 'install failed: npm ci exited 1' }),
    ])
    expect(failed.preview.error).toEqual({ status: 'failed', reason: 'install failed: npm ci exited 1' })
    expect(failed.preview.ready).toBe(false)
    expect(failed.preview.starting).toBe(false)

    // A retry's spinner supersedes the prior failure (error cleared on the next 'starting' frame).
    const retried = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'failed', reason: 'boom' }),
      ev({ kind: 'preview_status', status: 'starting' }),
    ])
    expect(retried.preview.error).toBeUndefined()
    expect(retried.preview.starting).toBe(true)
  })
  it('surfaces an unsupported preview (no reason) and a later ready clears it', () => {
    const unsupported = foldSessionView('s1', [ev({ kind: 'preview_status', status: 'unsupported' })])
    expect(unsupported.preview.error).toEqual({ status: 'unsupported' })
    const ready = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'unsupported' }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
    ])
    expect(ready.preview.error).toBeUndefined()
    expect(ready.preview.ready).toBe(true)
  })

  // Regression (PR #82 review): a RE-RUN that fails must NOT keep the stale /preview/ url — else
  // `embeddable` stays true in PreviewPanel and the dead iframe shadows the error card + Retry,
  // silently re-introducing the very dead-end this surfacing exists to kill. The real backend
  // lifecycle on a re-run is ready(url) → stopped(url, retained by stop()) → starting → failed.
  it('clears the stale url when a previously-ready preview is re-run and fails (no shadow iframe)', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'stopped', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'starting' }),
      ev({ kind: 'preview_status', status: 'failed', reason: 'readiness probe timed out' }),
    ])
    expect(v.preview.url).toBeUndefined() // torn-down url gone → not embeddable → error card wins
    expect(v.preview.error).toEqual({ status: 'failed', reason: 'readiness probe timed out' })
    expect(v.preview.ready).toBe(false)
    expect(v.preview.starting).toBe(false)
  })
  it('drops the stale url on a re-run starting frame so the spinner shows (not the old iframe)', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'starting' }),
    ])
    expect(v.preview.url).toBeUndefined()
    expect(v.preview.starting).toBe(true)
  })

  // A3.2/A3.4 — the backend's replay-time projection rewrites a dead liveness claim to a
  // terminal 'stopped' frame (url stripped). Folding that projected replay must land on the
  // recoverable PAUSE state (Run affordance), never a dead iframe or ghost spinner.
  it("folds a projected replay ending in 'stopped' to ready=false, url=undefined, stopped=true", () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }), // an earlier genuine frame
      ev({ kind: 'preview_status', status: 'stopped' }),                    // the projected last frame
    ])
    expect(v.preview.ready).toBe(false)
    expect(v.preview.url).toBeUndefined()
    expect(v.preview.stopped).toBe(true)
    expect(v.preview.starting).toBe(false)
  })

  it('folds the structured code_review verdict (last wins) as a read-only card', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'code_review', approved: false, findings: 4, critical: true, iteration: 1, agent: 'critic' }),
      ev({ kind: 'code_review', approved: true, findings: 0, critical: false, iteration: 2, agent: 'critic' }),
    ])
    expect(v.codeReview).toEqual({ approved: true, findings: 0, critical: false, iteration: 2 })
  })

  it('a tool_result with no open agent step does not push an orphan error (M5)', () => {
    const v = foldSessionView('s1', [ev({ kind: 'tool_result', tool: 'dispatch_proto', ok: false, result: { error: 'x' }, agent: 'proto' })])
    expect(v.errors).toHaveLength(0) // no step to attach to → no inconsistent orphan error
  })

  it('attaches text narration to the current agent step', () => {
    const events: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }),
      ev({ kind: 'text', text: 'thinking about the spec', agent: 'scribe' }),
    ]
    const v = foldSessionView('s1', events)
    expect(v.lanes[0]!.steps[0]!.notes).toContain('thinking about the spec')
  })

  it('folds a critic_resolution recovery (awaiting → resolved, last wins)', () => {
    const awaiting = foldSessionView('s1', [ev({ kind: 'recovery', recovery: 'critic_resolution', state: 'awaiting' })])
    expect(awaiting.recovery).toEqual({ critic: 'awaiting' })
    const resolved = foldSessionView('s1', [
      ev({ kind: 'recovery', recovery: 'critic_resolution', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'critic_resolution', state: 'resolved' }),
    ])
    expect(resolved.recovery).toEqual({ critic: 'resolved' })
  })

  it('folds a verify_failed recovery (retry awaiting → resolved, last wins)', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }),
    ])
    expect(v.verifyFailed).toEqual({ retry: 'awaiting' })
    const resolved = foldSessionView('s1', [
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'resolved' }),
    ])
    expect(resolved.verifyFailed).toEqual({ retry: 'resolved' })
  })

  it('folds a push_failed recovery (retry awaiting → resolved, last wins)', () => {
    const v = foldSessionView('s1', [ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' })])
    expect(v.pushFailed).toEqual({ retry: 'awaiting' })
    const resolved = foldSessionView('s1', [
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'resolved' }),
    ])
    expect(resolved.pushFailed).toEqual({ retry: 'resolved' })
  })

  it('folds a cancelled session into a distinct terminal status (not done, not failed)', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'session', status: 'started' }),
      ev({ kind: 'session', status: 'cancelled' }),
    ])
    expect(v.status).toBe('cancelled')
  })

  // ── Per-agent cost metrics ride on agent_end and fold onto the step (live AND history). ──
  it('folds agent_end metrics onto the step (live)', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', metrics: { usage: { inTokens: 200, outTokens: 1500 }, durationMs: 4_000, toolCalls: 1 } }),
    ])
    const step = v.lanes.find(l => l.laneId === 'main')!.steps[0]!
    expect(step.metrics).toEqual({ usage: { inTokens: 200, outTokens: 1500 }, durationMs: 4_000, toolCalls: 1 })
  })

  it('an agent_end WITHOUT metrics leaves step.metrics undefined (back-compat)', () => {
    const v = foldSessionView('s1', [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe' }),
    ])
    expect(v.lanes[0]!.steps[0]!.metrics).toBeUndefined()
  })

  it('reproduces metrics from a REPLAYED log (history badges restored for free, no extra code)', () => {
    // Exactly the events /log replays: a usage-absent Trace + a present-usage Proto. Folding
    // them rebuilds step.metrics, so a reopened session shows the same badges with no plumbing.
    const replayed: AkisEvent[] = [
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId: 'main' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', laneId: 'main', metrics: { usage: { inTokens: 50, outTokens: 70 }, durationMs: 3_000, toolCalls: 1 } }),
      ev({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'agent_end', role: 'trace', ok: true, agent: 'trace', laneId: 'verify', metrics: { durationMs: 900, toolCalls: 1 } }),
    ]
    const v = foldSessionView('s1', replayed)
    const proto = v.lanes.find(l => l.laneId === 'main')!.steps[0]!
    const trace = v.lanes.find(l => l.laneId === 'verify')!.steps[0]!
    expect(proto.metrics?.usage).toEqual({ inTokens: 50, outTokens: 70 })
    expect(trace.metrics && 'usage' in trace.metrics).toBe(false) // usage absent → "—"
    expect(trace.metrics?.durationMs).toBe(900)
  })
})
