import { describe, it, expect, vi } from 'vitest'
import { HttpMcpTransport, buildBearerInit } from '../../src/agent/mcp/HttpMcpTransport.js'
import { McpUnavailableError } from '../../src/agent/mcp/McpTransport.js'
import type { McpClientLike, McpConnection } from '../../src/agent/mcp/StdioDockerTransport.js'

/** A fake connected MCP client + the connect factory that yields it (records the bearer it got). */
function fakeConn(over: Partial<McpClientLike> = {}) {
  const closed = { value: false }
  const client: McpClientLike = {
    listTools: async () => ({ tools: [{ name: 'createPage', description: 'Create a Confluence page', inputSchema: { type: 'object' } }] }),
    callTool: async () => ({ content: [{ type: 'text', text: 'ok' }], isError: false }),
    close: async () => { closed.value = true },
    ...over,
  }
  return { client, closed }
}

describe('HttpMcpTransport', () => {
  it('initialize connects once (idempotent) and listTools normalizes the SDK shape', async () => {
    let connects = 0
    const { client } = fakeConn()
    const t = new HttpMcpTransport({ url: 'https://mcp.example/v1', token: 'tok', connect: async () => { connects++; return { client } } })
    await t.initialize()
    await t.initialize() // idempotent
    expect(connects).toBe(1)
    const tools = await t.listTools()
    expect(tools).toEqual([{ name: 'createPage', description: 'Create a Confluence page', inputSchema: { type: 'object' } }])
  })

  it('passes the OAuth token to connect (header channel) and never via a tool arg', async () => {
    let seenToken: string | undefined
    const { client } = fakeConn()
    const t = new HttpMcpTransport({ url: 'https://mcp.example/v1', token: 'secret-bearer', connect: async (_u, token) => { seenToken = token; return { client } } })
    await t.initialize()
    expect(seenToken).toBe('secret-bearer')
  })

  it('callTool flattens content blocks + maps isError', async () => {
    const { client } = fakeConn({ callTool: async () => ({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false }) })
    const t = new HttpMcpTransport({ url: 'u', token: 'tok', connect: async () => ({ client }) })
    await t.initialize()
    expect(await t.callTool('createPage', { title: 'X' })).toEqual({ text: 'a\nb', isError: false })
  })

  it('a connect failure becomes a FIXED, token-free McpUnavailableError', async () => {
    const t = new HttpMcpTransport({ url: 'u', token: 'tok', connect: async () => { throw new Error('401 Unauthorized: bearer secret-bearer leaked') } })
    await expect(t.initialize()).rejects.toBeInstanceOf(McpUnavailableError)
    await expect(t.initialize()).rejects.toThrow(/remote-mcp: server unavailable/) // no token/url echoed
  })

  it('a connect that exceeds initTimeoutMs rejects (token-free) and reaps the late connection', async () => {
    const { client, closed } = fakeConn()
    let resolveLate: (c: McpConnection) => void = () => {}
    const late = new Promise<McpConnection>(r => { resolveLate = r })
    const t = new HttpMcpTransport({
      url: 'u', token: 'tok', initTimeoutMs: 5,
      connect: () => late,
      setTimer: (cb) => { cb(); return { clear: () => {} } }, // fire the timeout immediately
    })
    await expect(t.initialize()).rejects.toBeInstanceOf(McpUnavailableError)
    resolveLate({ client }) // connect resolves AFTER the timeout → must be reaped (closed)
    await new Promise(r => setTimeout(r, 0))
    expect(closed.value).toBe(true)
  })

  it('close() closes the client and is idempotent', async () => {
    const { client, closed } = fakeConn()
    const t = new HttpMcpTransport({ url: 'u', token: 'tok', connect: async () => ({ client }) })
    await t.initialize()
    await t.close()
    await t.close()
    expect(closed.value).toBe(true)
  })

  it('listTools before initialize throws (not initialized)', async () => {
    const t = new HttpMcpTransport({ url: 'u', token: 'tok', connect: async () => ({ client: fakeConn().client }) })
    await expect(t.listTools()).rejects.toBeInstanceOf(McpUnavailableError)
  })
})

describe('HttpMcpTransport — buildBearerInit (the SDK-fetch header normalization)', () => {
  const bearerOf = (init: RequestInit) => new Headers(init.headers).get('Authorization')

  it('injects the bearer when the SDK passes NO init/headers', () => {
    expect(bearerOf(buildBearerInit('tok', undefined))).toBe('Bearer tok')
    expect(bearerOf(buildBearerInit('tok', {}))).toBe('Bearer tok')
  })

  it('injects the bearer alongside a plain-object headers init (and preserves the others)', () => {
    const init = buildBearerInit('tok', { headers: { Accept: 'text/event-stream' } })
    expect(bearerOf(init)).toBe('Bearer tok')
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream')
  })

  it('injects the bearer when headers is a Headers INSTANCE (object spread would drop these)', () => {
    const h = new Headers()
    h.set('Accept', 'text/event-stream')
    const init = buildBearerInit('tok', { headers: h })
    expect(bearerOf(init)).toBe('Bearer tok')
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream')
  })

  it('injects the bearer when headers is a [k,v][] ARRAY (object spread would drop these)', () => {
    const init = buildBearerInit('tok', { headers: [['Accept', 'text/event-stream'], ['X-Trace', '1']] })
    expect(bearerOf(init)).toBe('Bearer tok')
    expect(new Headers(init.headers).get('Accept')).toBe('text/event-stream')
    expect(new Headers(init.headers).get('X-Trace')).toBe('1')
  })

  it('the injected Authorization wins over any caller-supplied one (the bearer is authoritative)', () => {
    const init = buildBearerInit('tok', { headers: { Authorization: 'Bearer stale' } })
    expect(bearerOf(init)).toBe('Bearer tok')
  })

  it('preserves non-header init fields (method/body) untouched', () => {
    const init = buildBearerInit('tok', { method: 'POST', body: 'payload' })
    expect(init.method).toBe('POST')
    expect(init.body).toBe('payload')
    expect(bearerOf(init)).toBe('Bearer tok')
  })
})
