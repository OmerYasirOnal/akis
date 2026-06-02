import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import { StatsCollector } from '../../src/analytics/StatsCollector.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }, sid = 's1'): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: sid, ts: 0, ...(e as object) }) as AkisEvent

describe('StatsCollector', () => {
  it('aggregates sessions, verify pass-rate, per-agent runs, and provider via a bus tap', () => {
    const bus = new EventBus()
    const stats = new StatsCollector()
    stats.attach(bus)

    bus.emit(ev({ kind: 'session', status: 'started' }, 's1'))
    bus.emit(ev({ kind: 'agent_start', agent: 'scribe', role: 'scribe' }, 's1'))
    bus.emit(ev({ kind: 'agent_end', agent: 'scribe', role: 'scribe', ok: true }, 's1'))
    bus.emit(ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }, 's1'))
    bus.emit(ev({ kind: 'done', verified: true, provider: 'anthropic' }, 's1'))

    bus.emit(ev({ kind: 'session', status: 'started' }, 's2'))
    bus.emit(ev({ kind: 'verify', testsRun: 1, passed: false, agent: 'trace', laneId: 'verify' }, 's2'))
    bus.emit(ev({ kind: 'session', status: 'failed' }, 's2'))

    const a = stats.snapshot()
    expect(a.sessions).toBe(2)
    expect(a.done).toBe(1)
    expect(a.failed).toBe(1)
    expect(a.running).toBe(0)
    expect(a.verifiedRuns).toBe(1)
    expect(a.testsRun).toBe(4)
    expect(a.passRate).toBeCloseTo(0.5)
    expect(a.provider).toBe('anthropic')
    expect(a.agents.find(x => x.agent === 'scribe')).toEqual({ agent: 'scribe', runs: 1, ok: 1 })
  })

  it('counts a started-but-unfinished session as running', () => {
    const bus = new EventBus(); const stats = new StatsCollector(); stats.attach(bus)
    bus.emit(ev({ kind: 'session', status: 'started' }, 's1'))
    expect(stats.snapshot().running).toBe(1)
  })

  it('a throwing tap never breaks emit (isolation)', () => {
    const bus = new EventBus()
    bus.tap(() => { throw new Error('boom') })
    expect(() => bus.emit(ev({ kind: 'session', status: 'started' }))).not.toThrow()
  })
})
