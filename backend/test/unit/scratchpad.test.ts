import { describe, it, expect } from 'vitest'
import { foldScratchpad } from '../../src/context/scratchpad.js'
import type { AkisEvent } from '@akis/shared'

const base = { agent: 'orchestrator' as const, laneId: 'main', sessionId: 's1', ts: 0 }

describe('foldScratchpad (typed scratchpad derived from the event log)', () => {
  it('is empty for an empty log', () => {
    const sp = foldScratchpad([])
    expect(sp).toEqual({ gates: {}, notes: [], errors: [] })
  })

  it('folds gate events (last state wins)', () => {
    const events: AkisEvent[] = [
      { ...base, kind: 'gate', gate: 'spec_approval', state: 'awaiting' },
      { ...base, kind: 'gate', gate: 'spec_approval', state: 'satisfied' },
      { ...base, kind: 'gate', gate: 'push_confirm', state: 'awaiting' },
    ]
    const sp = foldScratchpad(events)
    expect(sp.gates).toEqual({ specApproval: 'satisfied', pushConfirm: 'awaiting' })
  })

  it('folds the verify event and the preview url', () => {
    const events: AkisEvent[] = [
      { ...base, agent: 'trace', kind: 'verify', testsRun: 3, passed: true },
      { ...base, kind: 'preview', url: 'https://github.com/mock/s1' },
    ]
    const sp = foldScratchpad(events)
    expect(sp.verification).toEqual({ testsRun: 3, passed: true })
    expect(sp.previewUrl).toBe('https://github.com/mock/s1')
  })

  it('collects narration into notes and failures into errors', () => {
    const events: AkisEvent[] = [
      { ...base, kind: 'text', text: 'Planning: todo' },
      { ...base, kind: 'tool_result', tool: 'dispatch_proto', ok: false, result: { error: 'boom' } },
      { ...base, kind: 'error', message: 'push failed: x' },
    ]
    const sp = foldScratchpad(events)
    expect(sp.notes).toContain('Planning: todo')
    expect(sp.errors.some(e => e.includes('boom'))).toBe(true)
    expect(sp.errors.some(e => e.includes('push failed'))).toBe(true)
  })

  it('caps notes and errors to the most recent N', () => {
    const many: AkisEvent[] = Array.from({ length: 50 }, (_, i) => ({ ...base, kind: 'text', text: `n${i}` }))
    const sp = foldScratchpad(many)
    expect(sp.notes.length).toBeLessThanOrEqual(20)
    expect(sp.notes[sp.notes.length - 1]).toBe('n49') // keeps the most recent
  })

  it('only events change the scratchpad (no other write path)', () => {
    const before = foldScratchpad([])
    const after = foldScratchpad([{ ...base, kind: 'gate', gate: 'spec_approval', state: 'satisfied' }])
    expect(before.gates.specApproval).toBeUndefined()
    expect(after.gates.specApproval).toBe('satisfied')
  })
})
