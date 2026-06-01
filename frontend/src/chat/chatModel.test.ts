import { describe, it, expect } from 'vitest'
import { foldChat, type AgentMsg, type GateMsg } from './chatModel.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

describe('foldChat', () => {
  it('opens with the user idea bubble', () => {
    const msgs = foldChat('build a todo app', [])
    expect(msgs[0]).toEqual({ id: 'user', kind: 'user', text: 'build a todo app' })
  })

  it('builds an agent turn with its tools and closes it', () => {
    const msgs = foldChat('x', [
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }),
      ev({ kind: 'tool_call', tool: 'dispatch_scribe', agent: 'scribe' }),
      ev({ kind: 'tool_result', tool: 'dispatch_scribe', ok: true, agent: 'scribe' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe' }),
    ])
    const turn = msgs.find(m => m.kind === 'agent') as AgentMsg
    expect(turn.agent).toBe('scribe')
    expect(turn.done).toBe(true)
    expect(turn.tools).toEqual([{ tool: 'dispatch_scribe', ok: true }])
  })

  it('shows orchestrator narration as its own bubble (no open turn)', () => {
    const msgs = foldChat('x', [ev({ kind: 'text', text: 'Planning: x' })])
    expect(msgs.some(m => m.kind === 'narration' && m.text === 'Planning: x')).toBe(true)
  })

  it('keeps a single gate card that updates in place (awaiting → satisfied)', () => {
    const msgs = foldChat('x', [
      ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }),
      ev({ kind: 'gate', gate: 'spec_approval', state: 'satisfied' }),
    ])
    const gateCards = msgs.filter(m => m.kind === 'gate') as GateMsg[]
    expect(gateCards).toHaveLength(1)
    expect(gateCards[0]!.state).toBe('satisfied')
  })

  it('renders verify, preview and done cards', () => {
    const msgs = foldChat('x', [
      ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'done', verified: true, provider: 'anthropic' }),
    ])
    expect(msgs.some(m => m.kind === 'verify' && m.passed)).toBe(true)
    expect(msgs.some(m => m.kind === 'preview' && m.ready && m.url === '/preview/s1/')).toBe(true)
    expect(msgs.some(m => m.kind === 'done' && m.verified)).toBe(true)
  })
})
