import { describe, it, expect } from 'vitest'
import { foldRunBubbles, type AgentMsg, type GateMsg, type CodeReviewMsg } from './chatModel.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

describe('foldRunBubbles', () => {
  it('does NOT emit a synthetic user-idea bubble (the idea lives in the chat spine)', () => {
    expect(foldRunBubbles([])).toEqual([])
    const msgs = foldRunBubbles([ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' })])
    expect(msgs.some(m => m.kind === 'user')).toBe(false)
  })

  it('builds an agent turn with its tools and closes it', () => {
    const msgs = foldRunBubbles([
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

  it('shows orchestrator narration as its own (suppressible) bubble when no turn is open', () => {
    const msgs = foldRunBubbles([ev({ kind: 'text', text: 'Planning: x' })])
    expect(msgs.some(m => m.kind === 'narration' && m.text === 'Planning: x')).toBe(true)
  })

  it('folds text into an open agent turn notes (not a standalone narration bubble)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }),
      ev({ kind: 'text', text: 'writing index.html', agent: 'proto' }),
    ])
    const turn = msgs.find(m => m.kind === 'agent') as AgentMsg
    expect(turn.notes).toEqual(['writing index.html'])
    expect(msgs.some(m => m.kind === 'narration')).toBe(false)
  })

  it('keeps a single gate card that updates in place (awaiting → satisfied)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }),
      ev({ kind: 'gate', gate: 'spec_approval', state: 'satisfied' }),
    ])
    const gateCards = msgs.filter(m => m.kind === 'gate') as GateMsg[]
    expect(gateCards).toHaveLength(1)
    expect(gateCards[0]!.state).toBe('satisfied')
  })

  it('renders a read-only code_review card and updates it in place (last verdict wins)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'code_review', approved: false, findings: 3, critical: false, iteration: 1, agent: 'critic' }),
      ev({ kind: 'code_review', approved: true, findings: 0, critical: false, iteration: 2, agent: 'critic' }),
    ])
    const cards = msgs.filter(m => m.kind === 'code_review') as CodeReviewMsg[]
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'code_review', approved: true, findings: 0, critical: false, iteration: 2 })
  })

  it('renders verify, preview and done cards', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'done', verified: true, provider: 'anthropic' }),
    ])
    expect(msgs.some(m => m.kind === 'verify' && m.passed)).toBe(true)
    expect(msgs.some(m => m.kind === 'preview' && m.ready && m.url === '/preview/s1/')).toBe(true)
    expect(msgs.some(m => m.kind === 'done' && m.verified)).toBe(true)
  })

  it('surfaces a recoverable preview failure as a preview card carrying its reason', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'preview_status', status: 'failed', reason: 'port in use' }),
    ])
    const preview = msgs.find(m => m.kind === 'preview')
    expect(preview).toMatchObject({ kind: 'preview', ready: false, error: { status: 'failed', reason: 'port in use' } })
  })

  it('appends an error row', () => {
    const msgs = foldRunBubbles([ev({ kind: 'error', message: 'boom' })])
    expect(msgs.some(m => m.kind === 'error' && m.text === 'boom')).toBe(true)
  })
})
