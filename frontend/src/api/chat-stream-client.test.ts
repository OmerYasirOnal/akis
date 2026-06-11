import { describe, it, expect, vi } from 'vitest'
import { ApiClient, ApiError } from './client.js'

/** A fetch double whose response body streams the given SSE chunks. */
function sseFetch(chunks: string[], { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        for (const c of chunks) controller.enqueue(enc.encode(c))
        controller.close()
      },
    })
    return { ok, status, body, json: async () => ({}) } as unknown as Response
  })
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('ApiClient.chatWithAkisStream', () => {
  it('calls onDelta per chunk and resolves with the full reply from the done frame', async () => {
    const fetchFn = sseFetch([
      frame('delta', { text: 'Hel' }),
      frame('delta', { text: 'lo ' }),
      frame('delta', { text: 'there' }),
      frame('done', { reply: 'Hello there' }),
    ])
    const api = new ApiClient('', fetchFn)
    const deltas: string[] = []
    const { reply } = await api.chatWithAkisStream('hi', [], d => deltas.push(d))
    expect(deltas).toEqual(['Hel', 'lo ', 'there'])
    expect(reply).toBe('Hello there')
    // It POSTed to the streaming endpoint with the message + history.
    const [url, init] = fetchFn.mock.calls[0]!
    expect(String(url)).toContain('/api/chat/stream')
    expect(JSON.parse(String(init?.body))).toMatchObject({ message: 'hi', history: [] })
  })

  it('handles an SSE frame split across two stream chunks', async () => {
    const fetchFn = sseFetch([
      'event: delta\ndata: {"text":"AB',
      '"}\n\nevent: done\ndata: {"reply":"AB"}\n\n',
    ])
    const api = new ApiClient('', fetchFn)
    const deltas: string[] = []
    const { reply } = await api.chatWithAkisStream('x', [], d => deltas.push(d))
    expect(deltas).toEqual(['AB'])
    expect(reply).toBe('AB')
  })

  it('throws ApiError when the server emits an error frame', async () => {
    const fetchFn = sseFetch([frame('error', { message: 'upstream boom', code: 'ProviderError' })])
    const api = new ApiClient('', fetchFn)
    await expect(api.chatWithAkisStream('hi', [], () => {})).rejects.toMatchObject({ code: 'ProviderError' })
  })

  it('throws ApiError on a non-ok response (so the caller can fall back)', async () => {
    const fetchFn = sseFetch([], { ok: false, status: 502 })
    const api = new ApiClient('', fetchFn)
    await expect(api.chatWithAkisStream('hi', [], () => {})).rejects.toBeInstanceOf(ApiError)
  })

  it('throws when the response carries no streamable body', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 200, body: null, json: async () => ({}) } as unknown as Response))
    const api = new ApiClient('', fetchFn)
    await expect(api.chatWithAkisStream('hi', [], () => {})).rejects.toThrow()
  })

  // F1(b) — the additive `scribe`/drafting control frame. The parser dispatches it to the optional
  // onScribe callback (the FE's live "Scribe is drafting…" signal) but it is NEVER a delta nor part
  // of the reply, so the conversation text is byte-identical with or without it.
  it('dispatches the `scribe` drafting frame to onScribe (and never as a delta / into the reply)', async () => {
    const fetchFn = sseFetch([
      frame('delta', { text: 'Handing off… ' }),
      frame('scribe', { scribe: 'drafting' }),
      frame('delta', { text: 'done' }),
      frame('done', { reply: 'Handing off… done' }),
    ])
    const api = new ApiClient('', fetchFn)
    const deltas: string[] = []
    const scribe: string[] = []
    const { reply } = await api.chatWithAkisStream('build it', [], d => deltas.push(d), undefined, undefined, s => scribe.push(s))
    expect(scribe).toEqual(['drafting'])
    expect(deltas).toEqual(['Handing off… ', 'done']) // the scribe frame was NOT a delta
    expect(reply).toBe('Handing off… done')
  })

  // BACKWARD-TOLERANT: an UNKNOWN event (and the scribe frame when onScribe is omitted) is ignored —
  // it must never throw, never become a delta, never corrupt the reply (old clients stay correct).
  it('safely IGNORES an unknown event and the scribe frame when onScribe is absent', async () => {
    const fetchFn = sseFetch([
      frame('delta', { text: 'A' }),
      frame('scribe', { scribe: 'drafting' }),
      frame('mystery', { whatever: 1 }),
      frame('delta', { text: 'B' }),
      frame('done', { reply: 'AB' }),
    ])
    const api = new ApiClient('', fetchFn)
    const deltas: string[] = []
    const { reply } = await api.chatWithAkisStream('hi', [], d => deltas.push(d)) // no onScribe
    expect(deltas).toEqual(['A', 'B'])
    expect(reply).toBe('AB')
  })
})
