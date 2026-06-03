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
    expect(v.preview).toEqual({ ready: true, starting: false, url: '/preview/s1/' })
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
})
