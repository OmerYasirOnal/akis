import { describe, it, expect } from 'vitest'
import { chatWithLiveNotes } from '../../src/orchestrator/subagents/streamNotes.js'
import type { LlmProvider, ChatResult } from '../../src/agent/LlmProvider.js'
import type { AkisEvent } from '@akis/shared'

function fakeBus() {
  const events: AkisEvent[] = []
  return { events, bus: { emit: (e: AkisEvent) => { events.push(e) } } as unknown as Parameters<typeof chatWithLiveNotes>[0]['bus'] }
}
const who = { agent: 'proto' as const, laneId: 'l', sessionId: 's' }
const req = { system: 'sys', messages: [{ role: 'user' as const, content: 'x' }] }

describe('chatWithLiveNotes (live build narration)', () => {
  it('falls back to chat() with NO text notes when the provider cannot stream', async () => {
    const { events, bus } = fakeBus()
    const provider = { name: 'm', model: 'm', chat: async (): Promise<ChatResult> => ({ text: 'done' }) } as unknown as LlmProvider
    const res = await chatWithLiveNotes({ bus, provider }, req, who)
    expect(res.text).toBe('done')
    expect(events.filter(e => e.kind === 'text')).toHaveLength(0)
  })

  it('streams CAPPED, EPHEMERAL text notes and still returns the full assembled result', async () => {
    const { events, bus } = fakeBus()
    const provider = {
      name: 'm', model: 'm',
      chat: async (): Promise<ChatResult> => ({ text: '' }),
      chatStream: async (_r: unknown, onDelta: (d: string) => void): Promise<ChatResult> => {
        let full = ''
        for (let i = 0; i < 60; i++) { const d = `chunk${i} `.padEnd(40, 'x'); full += d; onDelta(d) }
        return { text: full }
      },
    } as unknown as LlmProvider
    const res = await chatWithLiveNotes({ bus, provider }, req, who, { everyMs: 0, cap: 5 })
    const texts = events.filter((e): e is Extract<AkisEvent, { kind: 'text' }> => e.kind === 'text')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.length).toBeLessThanOrEqual(5)                 // hard-capped → never floods the stream
    expect(texts.every(e => e.ephemeral === true)).toBe(true)   // live-only → never ingested into RAG
    expect(res.text).toContain('chunk59')                       // full result preserved for downstream parsing
  })
})
