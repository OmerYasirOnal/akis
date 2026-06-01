import { describe, it, expect } from 'vitest'
import { postJson, AuthError, ModelNotFoundError, ProviderHttpError } from '../../src/agent/providers/http.js'

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

describe('postJson', () => {
  it('returns parsed json on 200', async () => {
    const fetchFn = (async () => res(200, { ok: true })) as unknown as typeof fetch
    expect(await postJson('http://x', {}, {}, { fetchFn })).toEqual({ ok: true })
  })
  it('maps 401 to AuthError', async () => {
    const fetchFn = (async () => res(401, { error: 'bad key' })) as unknown as typeof fetch
    await expect(postJson('http://x', {}, {}, { fetchFn })).rejects.toBeInstanceOf(AuthError)
  })
  it('maps 404 to ModelNotFoundError', async () => {
    const fetchFn = (async () => res(404, { error: 'no model' })) as unknown as typeof fetch
    await expect(postJson('http://x', {}, {}, { fetchFn })).rejects.toBeInstanceOf(ModelNotFoundError)
  })
  it('retries on 429 then succeeds', async () => {
    let n = 0
    const fetchFn = (async () => (++n < 2 ? res(429, {}, { 'retry-after': '0' }) : res(200, { ok: n }))) as unknown as typeof fetch
    expect(await postJson('http://x', {}, {}, { fetchFn, maxRetries: 3, baseDelayMs: 0 })).toEqual({ ok: 2 })
  })
  it('throws ProviderHttpError after exhausting retries', async () => {
    const fetchFn = (async () => res(500, {})) as unknown as typeof fetch
    await expect(postJson('http://x', {}, {}, { fetchFn, maxRetries: 1, baseDelayMs: 0 })).rejects.toBeInstanceOf(ProviderHttpError)
  })
  it('aborts a hung request when the timeout elapses', async () => {
    // A fetch that only settles when its signal aborts — proves the timeout fires.
    const fetchFn = ((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })) as unknown as typeof fetch
    await expect(postJson('http://x', {}, {}, { fetchFn, timeoutMs: 20 })).rejects.toThrow()
  })
  it('carries the response body on ProviderHttpError (for adapters to inspect)', async () => {
    const fetchFn = (async () => new Response('{"error":{"status":"INVALID_ARGUMENT"}}', { status: 400, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await postJson('http://x', {}, {}, { fetchFn }).catch((e: unknown) => {
      expect(e).toBeInstanceOf(ProviderHttpError)
      expect((e as ProviderHttpError).body).toContain('INVALID_ARGUMENT')
    })
  })
})
