import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
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
  /** SSE (legacy `/v1/sse`, default) or Streamable HTTP (the modern endpoint, e.g. Atlassian
   *  `/v1/mcp/authv2`). Both implement the same McpTransport seam above. */
  kind?: 'sse' | 'streamable-http'
  /** STATIC bearer (a PAT / Atlassian API-token / legacy path). Flows ONLY into the Authorization
   *  header; never argv/log. Exactly ONE of token / authProvider must be given. */
  token?: string
  /** The SDK OAuthClientProvider (browser OAuth + DCR + auto-refresh — see StoreBackedOAuthProvider).
   *  When given, the SDK owns auth: it attaches the bearer from the provider's tokens and refreshes
   *  on 401. Exactly ONE of token / authProvider must be given. */
  authProvider?: OAuthClientProvider
  /** A short client label for the MCP handshake (non-secret). */
  clientName?: string
  /** INTEGRATION/TEST boundary: build + connect an MCP client. Default = real SDK via dynamic import. */
  connect?: (args: ConnectArgs) => Promise<McpConnection>
  /** APP-LEVEL bound on the connect handshake. Default 10_000ms — a remote server that accepts the
   *  socket but never answers `initialize` must not stall the caller for the SDK's own ~60s. */
  initTimeoutMs?: number
  /** Injectable timer (tests). Default setTimeout (unref'd). */
  setTimer?: (cb: () => void, ms: number) => { clear: () => void }
}

/** What the (injectable) connect factory receives. Carries the auth method + transport kind so the
 *  default connect can pick the SDK transport + auth wiring. */
export interface ConnectArgs {
  url: string
  kind: 'sse' | 'streamable-http'
  token?: string
  authProvider?: OAuthClientProvider
  clientName: string
}

const defaultSetTimer = (cb: () => void, ms: number): { clear: () => void } => {
  const h = setTimeout(cb, ms)
  if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref()
  return { clear: () => clearTimeout(h) }
}

export class HttpMcpTransport implements McpTransport {
  private readonly url: string
  private readonly kind: 'sse' | 'streamable-http'
  private readonly token: string | undefined
  private readonly authProvider: OAuthClientProvider | undefined
  private readonly clientName: string
  private readonly connectFn: (args: ConnectArgs) => Promise<McpConnection>
  private readonly initTimeoutMs: number
  private readonly setTimer: (cb: () => void, ms: number) => { clear: () => void }
  private conn: McpConnection | undefined
  private closed = false

  constructor(opts: HttpMcpTransportOptions) {
    // Exactly one auth method — a transport with neither (or both) is a wiring bug, caught early.
    if (!opts.token === !opts.authProvider) {
      throw new Error('HttpMcpTransport: provide exactly one of { token, authProvider }')
    }
    this.url = opts.url
    this.kind = opts.kind ?? 'sse'
    this.token = opts.token
    this.authProvider = opts.authProvider
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
    const connectPromise = this.connectFn({
      url: this.url, kind: this.kind, clientName: this.clientName,
      ...(this.token !== undefined ? { token: this.token } : {}),
      ...(this.authProvider ? { authProvider: this.authProvider } : {}),
    })
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
/**
 * Merge `Authorization: Bearer <token>` into the request headers WITHOUT dropping the SDK's own.
 * The SDK passes a `Headers` INSTANCE to the custom fetch; object-spreading a Headers instance
 * yields {} (no own enumerable keys), which would strip `Accept: text/event-stream` (the SSE GET)
 * and `content-type: application/json` (the JSON-RPC POST) and break the real connection.
 * `new Headers(init)` copies a Headers instance OR a plain object/tuple list, so every SDK header
 * survives. EXPORTED so the header-preservation invariant is unit-testable without a live fetch.
 */
export function withBearer(initHeaders: HeadersInit | undefined, token: string): Headers {
  const headers = new Headers(initHeaders)
  headers.set('Authorization', `Bearer ${token}`)
  return headers
}

const defaultConnect = async (args: ConnectArgs): Promise<McpConnection> => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const url = new URL(args.url)
  // AUTH wiring: with an authProvider, the SDK owns auth (bearer from provider.tokens + refresh on
  // 401). With a static token, inject the bearer on EVERY request via a custom fetch that PRESERVES
  // the SDK's own headers (withBearer). Either way the token never reaches argv/logs.
  const bearerFetch = args.token === undefined ? undefined : (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    fetch(input, { ...init, headers: withBearer(init?.headers, args.token as string) })
  const opts: Record<string, unknown> = {}
  if (args.authProvider) opts.authProvider = args.authProvider
  if (bearerFetch) opts.fetch = bearerFetch
  let transport: unknown
  if (args.kind === 'streamable-http') {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    transport = new StreamableHTTPClientTransport(url, opts as ConstructorParameters<typeof StreamableHTTPClientTransport>[1])
  } else {
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
    transport = new SSEClientTransport(url, opts as ConstructorParameters<typeof SSEClientTransport>[1])
  }
  const client = new Client({ name: args.clientName, version: '1.0.0' }, { capabilities: {} })
  // SDK-boundary cast: the SDK transport's optional fields trip exactOptionalPropertyTypes against
  // the Client.connect param; this is the dynamic-import seam where SDK types are opaque (mirrors
  // StdioDockerTransport's `as unknown as McpClientLike`).
  await client.connect(transport as Parameters<typeof client.connect>[0])
  return { client: client as unknown as McpClientLike }
}
