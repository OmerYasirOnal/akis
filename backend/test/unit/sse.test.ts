import { describe, it, expect } from 'vitest'
import { sseEvent, sseControl, sseComment } from '../../src/api/sse.js'
import type { AkisEvent } from '@akis/shared'

const e: AkisEvent = { kind: 'text', text: 'hi', agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 1 }

describe('SSE framing', () => {
  it('frames an event with id: <seq> and data: <json>, terminated by a blank line', () => {
    const out = sseEvent(7, e)
    expect(out).toBe(`id: 7\ndata: ${JSON.stringify(e)}\n\n`)
  })

  it('emits a named control frame (event: + data:)', () => {
    expect(sseControl('reset', { head: 12 })).toBe('event: reset\ndata: {"head":12}\n\n')
  })

  it('emits a comment line for keep-alive', () => {
    expect(sseComment('ping')).toBe(': ping\n\n')
  })

  it('escapes newlines inside data via JSON (no frame-splitting injection)', () => {
    const multiline: AkisEvent = { ...e, kind: 'text', text: 'a\nb' }
    const out = sseEvent(1, multiline)
    // The raw newline must be JSON-escaped (\\n), so the frame has exactly one
    // blank-line terminator and cannot be split by event content.
    expect(out.endsWith('\n\n')).toBe(true)
    expect(out.split('\n\n')).toHaveLength(2)
    expect(out).toContain('a\\nb')
  })
})
