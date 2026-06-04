import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiClient, ApiError } from './client.js'

function mockFetch(status: number, body: unknown) {
  return vi.fn((_input: string, _init?: RequestInit) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response))
}
afterEach(() => vi.restoreAllMocks())

describe('ApiClient', () => {
  it('startSession POSTs the idea and returns the session', async () => {
    const f = mockFetch(201, { id: 's1', status: 'awaiting_spec_approval', version: 1 })
    const api = new ApiClient('', f)
    const s = await api.startSession('todo app')
    expect(s.id).toBe('s1')
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/sessions')
    expect(init!.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({ idea: 'todo app' })
  })

  it('startSession carries baseSessionId for a follow-up EDIT build (omitted when absent)', async () => {
    const f = mockFetch(201, { id: 's2', status: 'awaiting_spec_approval', version: 1 })
    const api = new ApiClient('', f)
    await api.startSession('add a login page', undefined, 'prior-1')
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ idea: 'add a login page', baseSessionId: 'prior-1' })
  })

  it('approve/run/confirm hit the right endpoints', async () => {
    const f = mockFetch(200, { id: 's1', status: 'building', version: 2 })
    const api = new ApiClient('', f)
    await api.approve('s1'); await api.run('s1'); await api.confirm('s1')
    expect(f.mock.calls.map(c => c[0])).toEqual(['/sessions/s1/approve', '/sessions/s1/run', '/sessions/s1/confirm'])
    expect(f.mock.calls.every(c => (c[1] as RequestInit).method === 'POST')).toBe(true)
  })

  it('getSession GETs and listProviders GETs', async () => {
    const f = mockFetch(200, { id: 's1', status: 'done', version: 3 })
    const api = new ApiClient('', f)
    await api.getSession('s1')
    expect(f.mock.calls[0]![0]).toBe('/sessions/s1')
  })

  it('maps a gate 409 to a typed ApiError', async () => {
    const f = mockFetch(409, { error: 'Cannot push', code: 'NotVerifiedError' })
    const api = new ApiClient('', f)
    await expect(api.confirm('s1')).rejects.toMatchObject({ name: 'ApiError', status: 409, code: 'NotVerifiedError' })
    expect(ApiError.is(await api.confirm('s1').catch(e => e))).toBe(true)
  })

  it('getSessionLog returns the events array from /log', async () => {
    const f = mockFetch(200, { events: [{ seq: 1, event: { kind: 'text' } }], head: 1 })
    const api = new ApiClient('', f)
    const log = await api.getSessionLog('s1')
    expect(f.mock.calls[0]![0]).toBe('/sessions/s1/log')
    expect(log).toHaveLength(1)
    expect(log[0]!.seq).toBe(1)
  })

  it('maps a non-JSON error body to a generic ApiError (no throw on bad body)', async () => {
    const f = vi.fn((_i: string, _n?: RequestInit) =>
      Promise.resolve({ ok: false, status: 500, json: async () => { throw new Error('not json') }, text: async () => '' } as unknown as Response))
    const api = new ApiClient('', f)
    await expect(api.getSession('s1')).rejects.toMatchObject({ name: 'ApiError', status: 500 })
  })

  it('honors a base url', async () => {
    const f = mockFetch(201, { id: 's1', status: 'x', version: 1 })
    const api = new ApiClient('http://host:3000', f)
    await api.startSession('x')
    expect(f.mock.calls[0]![0]).toBe('http://host:3000/sessions')
  })

  it('fires onUnauthorized once on a 401 and still rejects with a typed ApiError(401)', async () => {
    const f = mockFetch(401, { error: 'Unauthorized', code: 'Unauthorized' })
    const onUnauthorized = vi.fn()
    const api = new ApiClient('', f)
    api.onUnauthorized = onUnauthorized
    await expect(api.chatWithAkis('hi')).rejects.toMatchObject({ name: 'ApiError', status: 401 })
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('does NOT fire onUnauthorized for the /auth/me probe (avoids a redirect loop on anon load)', async () => {
    const f = mockFetch(401, { error: 'Unauthorized', code: 'Unauthorized' })
    const onUnauthorized = vi.fn()
    const api = new ApiClient('', f)
    api.onUnauthorized = onUnauthorized
    await expect(api.me()).rejects.toMatchObject({ name: 'ApiError', status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('does NOT fire onUnauthorized for a non-401 error', async () => {
    const f = mockFetch(409, { error: 'gate', code: 'NotVerifiedError' })
    const onUnauthorized = vi.fn()
    const api = new ApiClient('', f)
    api.onUnauthorized = onUnauthorized
    await expect(api.confirm('s1')).rejects.toMatchObject({ status: 409 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })
})
