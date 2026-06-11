import { describe, it, expect } from 'vitest'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { EventBus } from '../../src/events/bus.js'
import type { AkisEvent } from '@akis/shared'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'

/** A spy provider that records every ChatRequest and returns a canned result. */
function spyProvider(result: ChatResult): LlmProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = []
  return {
    name: 'spy', model: 'spy-model', calls,
    async chat(req: ChatRequest): Promise<ChatResult> { calls.push(req); return result },
  }
}

const SPEC_JSON = JSON.stringify({ kind: 'spec', title: 'Todo App', body: '# Todo App\n\n## Problem\n…\n\n## Acceptance criteria\n- Given … Then …' })

describe('ScribeAgent.draftSpec — the bus-free chat-time entry point (Option A)', () => {
  it('returns the parsed {title, body} from the provider output', async () => {
    const p = spyProvider({ text: SPEC_JSON, usage: { inTokens: 120, outTokens: 340 } })
    const scribe = new ScribeAgent({ bus: new EventBus(), provider: p })
    const out = await scribe.draftSpec({ brief: 'a todo app' })
    expect(out.spec).toEqual({ title: 'Todo App', body: '# Todo App\n\n## Problem\n…\n\n## Acceptance criteria\n- Given … Then …' })
    expect(out.parsed).toBe(true)
  })

  it('threads the REAL usage through (for the honest synthetic-Scribe metrics)', async () => {
    const p = spyProvider({ text: SPEC_JSON, usage: { inTokens: 120, outTokens: 340 } })
    const out = await new ScribeAgent({ bus: new EventBus(), provider: p }).draftSpec({ brief: 'x' })
    expect(out.usage).toEqual({ inTokens: 120, outTokens: 340 })
  })

  it('sends the SKILL-INJECTED system prompt (the DI-composed base), not a chat persona', async () => {
    const p = spyProvider({ text: SPEC_JSON })
    // The DI layer injects the skill-composed prompt as `systemPrompt`; draftSpec must use it.
    const injected = 'SKILL-COMPOSED SCRIBE PROMPT — author a spec'
    const scribe = new ScribeAgent({ bus: new EventBus(), provider: p, systemPrompt: injected })
    await scribe.draftSpec({ brief: 'a todo app' })
    expect(p.calls[0]?.system).toBe(injected)
  })

  it('defaults to SCRIBE_SYSTEM when no skill prompt is injected', async () => {
    const { SCRIBE_SYSTEM } = await import('../../src/orchestrator/subagents/ScribeAgent.js')
    const p = spyProvider({ text: SPEC_JSON })
    await new ScribeAgent({ bus: new EventBus(), provider: p }).draftSpec({ brief: 'x' })
    expect(p.calls[0]?.system).toBe(SCRIBE_SYSTEM)
  })

  it('passes the brief AND the bounded conversation as the user message', async () => {
    const p = spyProvider({ text: SPEC_JSON })
    await new ScribeAgent({ bus: new EventBus(), provider: p }).draftSpec({
      brief: 'a todo app with due dates',
      conversation: [
        { role: 'user', content: 'I want a todo app' },
        { role: 'assistant', content: 'Sure — any extras?' },
        { role: 'user', content: 'due dates and dark mode' },
      ],
    })
    const userMsg = p.calls[0]?.messages.map(m => m.content).join('\n') ?? ''
    expect(userMsg).toContain('a todo app with due dates') // the brief
    expect(userMsg).toContain('due dates and dark mode') // the conversation
  })

  it('emits NO bus events (chat time has no session/lane — this is data-only)', async () => {
    const bus = new EventBus()
    const seen: AkisEvent[] = []
    bus.tap((e: AkisEvent) => { seen.push(e) })
    const p = spyProvider({ text: SPEC_JSON })
    await new ScribeAgent({ bus, provider: p }).draftSpec({ brief: 'x' })
    expect(seen).toHaveLength(0)
  })

  it('parsed=false on unparseable output (the route then surfaces an honest error, never a fake spec)', async () => {
    const p = spyProvider({ text: 'not json at all' })
    const out = await new ScribeAgent({ bus: new EventBus(), provider: p }).draftSpec({ brief: 'x' })
    expect(out.parsed).toBe(false)
  })

  it('re-throws a provider error (the route maps it to an honest chat error row)', async () => {
    const provider: LlmProvider = {
      name: 'down', model: 'down',
      async chat(): Promise<ChatResult> { throw new Error('provider down') },
    }
    await expect(new ScribeAgent({ bus: new EventBus(), provider }).draftSpec({ brief: 'x' })).rejects.toThrow('provider down')
  })
})
