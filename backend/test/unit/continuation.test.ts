import { describe, it, expect } from 'vitest'
import { chatWithContinuation } from '../../src/agent/continuation.js'
import type { ChatRequest, ChatResult, LlmProvider } from '../../src/agent/LlmProvider.js'

/** A scripted provider: returns the queued results in order and records every request. */
function scripted(results: ChatResult[]): LlmProvider & { calls: ChatRequest[] } {
  let i = 0
  const p: LlmProvider & { calls: ChatRequest[] } = {
    name: 'mock', model: 'mock-model', calls: [],
    async chat(req: ChatRequest): Promise<ChatResult> {
      p.calls.push(req)
      const r = results[Math.min(i, results.length - 1)]!
      i++
      return r
    },
  }
  return p
}

const req: ChatRequest = { system: 'sys', messages: [{ role: 'user', content: 'build it' }], maxTokens: 16384 }

describe('chatWithContinuation', () => {
  it('passes a naturally-stopped reply through with exactly ONE call', async () => {
    const p = scripted([{ text: '{"files":[]}', stopReason: 'end_turn' }])
    const res = await chatWithContinuation(p, req)
    expect(res.text).toBe('{"files":[]}')
    expect(p.calls.length).toBe(1)
  })

  it('passes a stopReason-less reply through untouched (older adapters, mock provider)', async () => {
    const p = scripted([{ text: 'plain' }])
    const res = await chatWithContinuation(p, req)
    expect(res.text).toBe('plain')
    expect(p.calls.length).toBe(1)
  })

  it('recovers a max_tokens truncation: continues with the partial as an assistant turn and CONCATENATES', async () => {
    const p = scripted([
      { text: '{"files":[{"filePath":"index.html","content":"<ht', stopReason: 'max_tokens' },
      { text: 'ml>app</html>"}]}', stopReason: 'end_turn' },
    ])
    const res = await chatWithContinuation(p, req)
    expect(res.text).toBe('{"files":[{"filePath":"index.html","content":"<html>app</html>"}]}')
    expect(p.calls.length).toBe(2)
    // The continuation turn replays history + the partial assistant text + a continue prompt.
    const cont = p.calls[1]!
    expect(cont.messages[1]).toMatchObject({ role: 'assistant', content: '{"files":[{"filePath":"index.html","content":"<ht' })
    expect(cont.messages[2]!.role).toBe('user')
    expect(cont.messages[2]!.content).toMatch(/Continue EXACTLY where you left off/)
    // System prompt resent verbatim (provider-side prompt caching keeps it cheap).
    expect(cont.system).toBe('sys')
  })

  it('handles every provider cap spelling (max_tokens / MAX_TOKENS / length)', async () => {
    for (const reason of ['max_tokens', 'MAX_TOKENS', 'length']) {
      const p = scripted([
        { text: 'part1-', stopReason: reason },
        { text: 'part2', stopReason: 'stop' },
      ])
      const res = await chatWithContinuation(p, req)
      expect(res.text).toBe('part1-part2')
    }
  })

  it('is BOUNDED: a model that always hits the cap stops after maxContinues rounds', async () => {
    const p = scripted([{ text: 'x', stopReason: 'max_tokens' }])
    const res = await chatWithContinuation(p, req, 3)
    expect(p.calls.length).toBe(4) // 1 initial + 3 continues, never more
    expect(res.text).toBe('xxxx')
  })
})
