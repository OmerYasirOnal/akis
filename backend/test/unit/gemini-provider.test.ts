import { describe, it, expect } from 'vitest'
import { GeminiProvider } from '../../src/agent/providers/GeminiProvider.js'
import { AuthError } from '../../src/agent/providers/http.js'

const body = {
  candidates: [{ content: { parts: [{ text: 'hi' }, { functionCall: { name: 'do', args: { x: 1 } } }] } }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
}

describe('GeminiProvider', () => {
  it('maps request (path model + x-goog-api-key + systemInstruction) and parses functionCall', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchFn = (async (url: string, init: RequestInit) => {
      captured = { url, init }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch

    const p = new GeminiProvider({ apiKey: 'AIza-x', model: 'gemini-2.5-flash', fetchFn })
    const r = await p.chat({ system: 'SYS', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'do', description: 'd', schema: { type: 'object' } }] })

    const h = captured!.init.headers as Record<string, string>
    expect(captured!.url).toContain(':generateContent')
    expect(captured!.url).toContain('/models/gemini-2.5-flash')
    expect(h['x-goog-api-key']).toBe('AIza-x')
    const reqBody = JSON.parse(captured!.init.body as string)
    expect(reqBody.systemInstruction.parts[0].text).toBe('SYS')
    expect(reqBody.tools[0].functionDeclarations[0].parameters).toEqual({ type: 'object' })

    expect(r.text).toBe('hi')
    expect(r.toolCalls).toEqual([{ name: 'do', args: { x: 1 } }])
    expect(r.usage).toEqual({ inTokens: 2, outTokens: 3 })
  })

  it('maps a 400 PERMISSION_DENIED to AuthError', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const p = new GeminiProvider({ apiKey: 'bad', model: 'm', fetchFn })
    await expect(p.chat({ system: 's', messages: [] })).rejects.toBeInstanceOf(AuthError)
  })
  it('does NOT map a 400 INVALID_ARGUMENT to AuthError (request-shape bug stays visible)', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'bad contents' } }), { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const p = new GeminiProvider({ apiKey: 'AIza-good', model: 'm', fetchFn })
    await expect(p.chat({ system: 's', messages: [] })).rejects.not.toBeInstanceOf(AuthError)
  })
})
