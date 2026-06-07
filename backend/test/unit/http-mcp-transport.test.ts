import { describe, it, expect } from 'vitest'
import { HttpMcpTransport, withBearer } from '../../src/agent/mcp/HttpMcpTransport.js'
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
    const t = new HttpMcpTransport({ url: 'https://mcp.example/v1', token: 'secret-bearer', connect: async ({ token }) => { seenToken = token; return { client } } })
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

describe('HttpMcpTransport — auth method + transport kind', () => {
  it('requires EXACTLY one of { token, authProvider }', () => {
    expect(() => new HttpMcpTransport({ url: 'u' } as never)).toThrow(/exactly one/)
    expect(() => new HttpMcpTransport({ url: 'u', token: 't', authProvider: {} as never })).toThrow(/exactly one/)
  })

  it('passes the authProvider + kind through to connect (the OAuth path — SDK owns auth/refresh)', async () => {
    let seen: { kind?: string; hasProvider?: boolean; hasToken?: boolean } = {}
    const t = new HttpMcpTransport({
      url: 'https://mcp.atlassian.com/v1/mcp/authv2', kind: 'streamable-http', authProvider: { tokens: () => undefined } as never,
      connect: async (args) => { seen = { kind: args.kind, hasProvider: !!args.authProvider, hasToken: args.token !== undefined }; return { client: fakeConn().client } },
    })
    await t.initialize()
    expect(seen).toEqual({ kind: 'streamable-http', hasProvider: true, hasToken: false })
  })

  it('defaults to the sse kind when not specified', async () => {
    let seenKind: string | undefined
    const t = new HttpMcpTransport({ url: 'u', token: 'tok', connect: async (args) => { seenKind = args.kind; return { client: fakeConn().client } } })
    await t.initialize()
    expect(seenKind).toBe('sse')
  })
})

describe('withBearer — preserves the SDK headers + adds Authorization (HIGH-fix: Headers instance not dropped)', () => {
  it('keeps a Headers INSTANCE (Accept/content-type the SDK sets on the SSE GET + POST) and adds the bearer', () => {
    const sdkHeaders = new Headers({ Accept: 'text/event-stream', 'content-type': 'application/json' })
    const out = withBearer(sdkHeaders, 'tok')
    expect(out.get('Accept')).toBe('text/event-stream')       // object-spread would have dropped this
    expect(out.get('content-type')).toBe('application/json')
    expect(out.get('Authorization')).toBe('Bearer tok')
  })
  it('works with a plain-object headers init and with undefined', () => {
    expect(withBearer({ 'x-custom': '1' }, 'tok').get('x-custom')).toBe('1')
    expect(withBearer({ 'x-custom': '1' }, 'tok').get('Authorization')).toBe('Bearer tok')
    expect(withBearer(undefined, 'tok').get('Authorization')).toBe('Bearer tok')
  })
})
