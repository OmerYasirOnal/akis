import type { McpToolInfo, McpToolResult, McpTransport } from './McpTransport.js'
import { McpUnavailableError } from './McpTransport.js'
import type { McpClientLike, McpConnection } from './StdioDockerTransport.js'

/**
 * The concrete REMOTE (HTTP) MCP transport — for servers reached over the network with OAuth 2.1
 * bearer auth (e.g. the Atlassian Remote MCP server backing Jira/Confluence). It implements the
 * SAME `McpTransport` seam as StdioDockerTransport, so every caller above the seam (McpToolBridge,
 * the producers) is UNCHANGED — exactly the portability contract McpTransport documents.
 *
 * Differences from the stdio+Docker transport:
 *  - No child process / Docker — the connection is an HTTP(S) client to a remote URL.
 *  - The secret is the user's decrypted OAuth ACCESS TOKEN, sent ONLY as an `Authorization: Bearer`
 *    HEADER (never argv, never logged). Every connect/handshake error is caught and re-thrown as a
 *    FIXED, TOKEN-FREE McpUnavailableError (mirrors StdioDockerTransport + RealGitHubAdapter).
 *  - `close()` just closes the HTTP client (no child to reap).
 *
 * This is the TRANSPORT only. WRITE authorization is NOT here — a write tool surfaced from this
 * server still flows through the external-write gate (externalWriteGate.ts): the agent PROPOSES,
 * a human confirms, and only then does the server call this transport's `callTool` for the write.
 *
 * The SDK (`@modelcontextprotocol/sdk`) is loaded via DYNAMIC import in the default connect, so no
 * other module statically imports it and the unit-test graph never loads it (tests inject `connect`).
 */

export interface HttpMcpTransportOptions {
  /** The remote MCP server URL (e.g. the Atlassian Remote MCP endpoint). */
  url: string
  /** The decrypted OAuth access token. Flows ONLY into the Authorization header; never argv/log. */
  token: string
  /** A short client label for the MCP handshake (non-secret). */
  clientName?: string
  /** INTEGRATION/TEST boundary: build + connect an MCP client. Default = real SDK via dynamic import. */
  connect?: (url: string, token: string, clientName: string) => Promise<McpConnection>
  /** APP-LEVEL bound on the connect handshake. Default 10_000ms — a remote server that accepts the
   *  socket but never answers `initialize` must not stall the caller for the SDK's own ~60s. */
  initTimeoutMs?: number
  /** Injectable timer (tests). Default setTimeout (unref'd). */
  setTimer?: (cb: () => void, ms: number) => { clear: () => void }
}

const defaultSetTimer = (cb: () => void, ms: number): { clear: () => void } => {
  const h = setTimeout(cb, ms)
  if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref()
  return { clear: () => clearTimeout(h) }
}

/**
 * Return a copy of the SDK's `RequestInit` with the OAuth bearer set as the `Authorization` header.
 *
 * The header is normalized through `new Headers(init?.headers)` BEFORE setting Authorization, so a
 * caller-supplied `Headers` instance or `[k,v][]` array (both valid `HeadersInit` shapes the SDK may
 * pass) is preserved — an object-spread `{ ...init.headers }` would silently DROP those non-plain
 * shapes, stripping any headers the SDK relies on (e.g. SSE `Accept`). The injected Authorization is
 * authoritative (it `.set()`s last), so a stale caller value cannot shadow the real bearer. Non-header
 * init fields (method/body/signal…) pass through untouched.
 */
export function buildBearerInit(token: string, init: RequestInit | undefined): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...init, headers }
}

export class HttpMcpTransport implements McpTransport {
  private readonly url: string
  private readonly token: string
  private readonly clientName: string
  private readonly connectFn: (url: string, token: string, clientName: string) => Promise<McpConnection>
  private readonly initTimeoutMs: number
  private readonly setTimer: (cb: () => void, ms: number) => { clear: () => void }
  private conn: McpConnection | undefined
  private closed = false

  constructor(opts: HttpMcpTransportOptions) {
    this.url = opts.url
    this.token = opts.token
    this.clientName = opts.clientName ?? 'akis-remote-mcp'
    this.connectFn = opts.connect ?? defaultConnect
    this.initTimeoutMs = opts.initTimeoutMs ?? 10_000
    this.setTimer = opts.setTimer ?? defaultSetTimer
  }

  async initialize(): Promise<void> {
    if (this.conn) return // idempotent: one connection per lifetime
    // BOUND the connect handshake (mirrors Stdio): a server that accepts the socket but never
    // answers `initialize` would otherwise stall the caller. Race connect against initTimeoutMs and
    // reap a late-resolving connection so no token-bearing client leaks.
    let timer: { clear: () => void } | undefined
    let timedOut = false
    const connectPromise = this.connectFn(this.url, this.token, this.clientName)
    connectPromise.then(
      conn => { if (timedOut) void closeConnQuietly(conn) },
      () => { /* connect rejected — nothing to reap */ },
    )
    try {
      this.conn = await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          timer = this.setTimer(() => { timedOut = true; reject(new McpUnavailableError('remote-mcp: server failed to start')) }, this.initTimeoutMs)
        }),
      ])
    } catch {
      // FIXED, token-free message — nothing from the underlying error (which could carry the URL
      // or auth detail) is echoed.
      throw new McpUnavailableError('remote-mcp: server unavailable')
    } finally {
      timer?.clear()
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const conn = this.requireConn()
    const res = await conn.client.listTools()
    return res.tools.map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' } }))
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const conn = this.requireConn()
    const res = await conn.client.callTool({ name, arguments: args })
    const text = (res.content ?? []).map(c => (typeof c.text === 'string' ? c.text : '')).filter(s => s.length > 0).join('\n')
    return { text, isError: res.isError === true }
  }

  async close(): Promise<void> {
    if (this.closed) return // idempotent
    this.closed = true
    const conn = this.conn
    this.conn = undefined
    if (!conn) return
    // BOUND client.close() (mirrors Stdio): a wedged close must not hang forever.
    let timer: { clear: () => void } | undefined
    try {
      await Promise.race([
        conn.client.close().catch(() => {}),
        new Promise<void>(resolve => { timer = this.setTimer(resolve, this.initTimeoutMs) }),
      ])
    } catch {
      /* best-effort */
    } finally {
      timer?.clear()
    }
  }

  private requireConn(): McpConnection {
    if (!this.conn) throw new McpUnavailableError('remote-mcp: not initialized')
    return this.conn
  }
}

/** Close an UNOWNED connection (a connect that resolved AFTER initialize() timed out). */
async function closeConnQuietly(conn: McpConnection): Promise<void> {
  try { await conn.client.close() } catch { /* best-effort */ }
}

/**
 * The real connect: SDK Client + SSEClientTransport via DYNAMIC import (keeps the SDK out of every
 * other import graph). The Atlassian Remote MCP server speaks SSE (e.g. https://mcp.atlassian.com/
 * v1/sse), which this SDK version (1.29) provides; StreamableHTTP client is not in this SDK yet.
 *
 * AUTH: the OAuth access token travels ONLY as an `Authorization: Bearer` header, injected by a
 * custom `fetch` that the SDK uses for BOTH legs (the SSE GET stream + the recurring POSTs) — never
 * argv, never logged. Live-verify against the real Atlassian endpoint once OAuth creds are connected
 * (next slice: the Atlassian connection store + OAuth routes).
 */
const defaultConnect = async (url: string, token: string, clientName: string): Promise<McpConnection> => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
  // Inject the bearer on EVERY request (SSE GET + message POSTs). The SDK's `fetch` option is
  // documented as "used for all network requests", so the token reaches both legs via the header
  // channel only.
  const bearerFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(input as RequestInfo, buildBearerInit(token, init))
  const transport = new SSEClientTransport(new URL(url), { fetch: bearerFetch } as unknown as ConstructorParameters<typeof SSEClientTransport>[1])
  const client = new Client({ name: clientName, version: '1.0.0' }, { capabilities: {} })
  // SDK-boundary cast: the SDK transport's optional fields trip exactOptionalPropertyTypes against
  // the Client.connect param; this is the dynamic-import seam where SDK types are opaque (mirrors
  // StdioDockerTransport's `as unknown as McpClientLike`).
  await client.connect(transport as unknown as Parameters<typeof client.connect>[0])
  return { client: client as unknown as McpClientLike }
}
