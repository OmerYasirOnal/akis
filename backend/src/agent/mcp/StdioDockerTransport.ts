import type { McpToolInfo, McpToolResult, McpTransport } from './McpTransport.js'
import { McpUnavailableError } from './McpTransport.js'

/**
 * The concrete stdio+Docker MCP transport: it runs the OFFICIAL github-mcp-server as a
 * short-lived `docker run -i --rm … stdio` child, owned by the SDK's StdioClientTransport,
 * and speaks MCP over stdio. This is the ONLY file in the SP1 graph that touches
 * `@modelcontextprotocol/sdk` — and it does so via a DYNAMIC `await import(...)` (mirroring
 * PreviewRegistry's `await import('node:child_process')`), so no other module statically
 * imports the SDK and the unit-test graph never loads it.
 *
 * SECRETS: the session owner's decrypted OAuth token is passed via the env MAP handed to the
 * SDK transport (GITHUB_PERSONAL_ACCESS_TOKEN), NEVER via argv and NEVER logged. Every spawn/
 * connect error is caught and re-thrown as a FIXED, TOKEN-FREE McpUnavailableError that echoes
 * nothing from the underlying error (mirrors RealGitHubAdapter.send).
 *
 * UNTRUSTED-CODE HARDENING: the container runs read-only, drops all caps, and is bounded on
 * pids/memory/cpu; the image is pinned by sha256 DIGEST (supply-chain).
 *
 * INTEGRATION-ONLY: this file is never imported by a unit test. Tests use FakeMcpTransport.
 * For an integration boundary an optional `connect` factory may be injected (it returns an
 * already-connected MCP client + a child-kill hook); the default builds the real SDK client.
 */

/** github-mcp-server, pinned by sha256 digest (supply-chain). This is the REAL multi-arch
 *  manifest-index digest of the `main` tag on GHCR (resolved from the registry, not a
 *  placeholder), built from github-mcp-server source revision 457f59932ac041c9276e03e634b0e0c30f19ba3e.
 *  The read-only allow-list (readOnlyAllowlist.ts) was VERIFIED against the read tools THIS exact
 *  image advertises under the `repos,issues,pull_requests` toolsets — every allow-listed name
 *  (incl. the two consolidated `issue_read`/`pull_request_read` dispatchers) is a real MCP tool
 *  name in this revision's tool registration (pkg/github/{repositories,issues,pullrequests,search}.go). */
export const IMAGE =
  'ghcr.io/github/github-mcp-server@sha256:ecca307a8692c3329a5287f34b91e1359320af1f9b34e27abbe1836d65d017e8'

/** The hardening + invocation argv for the `docker run` child. The token is NOT here — it is
 *  passed via the env map only. shell:false is implicit (StdioClientTransport spawns directly).
 *  EXPORTED so the argv contract (image, --read-only, hardening flags, token-NOT-in-argv) is
 *  unit-testable without a real `docker run` (mirrors asserting OpenSshTransport's spawned argv).
 *
 *  CRITICAL (the `-e NAME` value-less form): `docker run` does NOT propagate the docker CLI's
 *  own process environment into the container — container env is injected ONLY via -e/--env/
 *  --env-file. Without these flags the env MAP we hand the SDK reaches the docker CLI but DIES
 *  there, so GITHUB_READ_ONLY=1 (the documented read-only backstop the allow-list leans on for
 *  the two consolidated `*_read` dispatchers) and the token never reach the server (every call
 *  401s). We pass each var in the VALUE-LESS `-e NAME` form so docker reads its value FROM the
 *  spawn env map at run time — the value still travels via the env channel ONLY, never via argv
 *  (preserving the no-secret-in-argv invariant: `ps`/`/proc` show `-e GITHUB_PERSONAL_ACCESS_TOKEN`,
 *  not its value). buildSpawnEnv() carries the matching keys. */
export function dockerArgs(): string[] {
  return [
    'run',
    '-i',
    '--rm',
    '--read-only',
    '--cap-drop=ALL',
    '--pids-limit=256',
    '--memory=512m',
    '--cpus=1',
    // Value-less `-e NAME`: docker reads each value from the spawn env map, NEVER from argv —
    // so the token (and the read-only backstop flag) actually reach the server inside the
    // container while staying out of the world-visible argv.
    '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN',
    '-e', 'GITHUB_READ_ONLY',
    '-e', 'GITHUB_TOOLSETS',
    IMAGE,
    'stdio',
  ]
}

/** The env MAP handed to the SDK's StdioClientTransport — the ONLY channel the token travels by
 *  (never argv, never logs, never disk). EXPORTED + pure so the token-under-the-right-var invariant
 *  is unit-testable directly on the EXACT object the real connect hands the SDK (not a copy). */
export function buildSpawnEnv(token: string, toolsets: string): Record<string, string> {
  return {
    GITHUB_PERSONAL_ACCESS_TOKEN: token,
    GITHUB_READ_ONLY: '1',
    GITHUB_TOOLSETS: toolsets,
  }
}

/** The minimal MCP client surface this transport drives (a subset of the SDK Client). Defined
 *  here so the injected `connect` factory (tests/integration) needs no SDK types. */
export interface McpClientLike {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }>
  callTool(args: { name: string; arguments: unknown }): Promise<{
    content?: Array<{ type?: string; text?: string }>
    isError?: boolean
  }>
  close(): Promise<void>
}

/** What `connect` resolves: a connected client + an optional best-effort child killer (SIGTERM
 *  then SIGKILL-after-grace) — a closed stdio client does NOT guarantee the `docker run` exits. */
export interface McpConnection {
  client: McpClientLike
  /** Best-effort terminate of the owned docker child. May be a no-op for a remote transport. */
  killChild?: () => void
}

export interface StdioDockerTransportOptions {
  /** The decrypted GitHub OAuth token. Flows ONLY into the env map; never argv/log/disk. */
  token: string
  /** Toolsets to enable on the server (read tools live under these). */
  toolsets?: string
  /** INTEGRATION/TEST boundary: build + connect an MCP client. Default = real SDK via dynamic import. */
  connect?: (token: string, toolsets: string) => Promise<McpConnection>
  /** Docker presence preflight. Default spawns `docker --version` (commandOnPath pattern). */
  dockerOnPath?: () => Promise<boolean>
  /** Grace (ms) between SIGTERM and SIGKILL on close(). Injectable for tests. */
  killGraceMs?: number
  /** APP-LEVEL bound on initialize() (connect handshake). Default 10_000ms. A wedged docker
   *  daemon / slow image pull / a container that spawns but whose MCP server never answers
   *  `initialize` would otherwise stall the Scribe critical path for up to the SDK's own ~60s
   *  request timeout before honest-absence degradation. Injectable for tests. */
  initTimeoutMs?: number
  /** Injectable timer (tests). Default setTimeout. Returns a handle with a clear() so the timeout
   *  never leaks past a fast connect. */
  setTimer?: (cb: () => void, ms: number) => { clear: () => void }
}

const defaultSetTimer = (cb: () => void, ms: number): { clear: () => void } => {
  const h = setTimeout(cb, ms)
  if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref()
  return { clear: () => clearTimeout(h) }
}

export class StdioDockerTransport implements McpTransport {
  private readonly token: string
  private readonly toolsets: string
  private readonly connectFn: (token: string, toolsets: string) => Promise<McpConnection>
  private readonly dockerOnPath: () => Promise<boolean>
  private readonly initTimeoutMs: number
  private readonly setTimer: (cb: () => void, ms: number) => { clear: () => void }
  private conn: McpConnection | undefined
  private closed = false

  constructor(opts: StdioDockerTransportOptions) {
    this.token = opts.token
    this.toolsets = opts.toolsets ?? 'repos,issues,pull_requests'
    this.connectFn = opts.connect ?? defaultConnect
    this.dockerOnPath = opts.dockerOnPath ?? defaultDockerOnPath
    this.initTimeoutMs = opts.initTimeoutMs ?? 10_000
    this.setTimer = opts.setTimer ?? defaultSetTimer
  }

  async initialize(): Promise<void> {
    if (this.conn) return // idempotent: one connection per lifetime
    // Preflight: no Docker on PATH ⇒ honest unavailability, never a raw spawn crash.
    let present: boolean
    try {
      present = await this.dockerOnPath()
    } catch {
      present = false
    }
    if (!present) throw new McpUnavailableError('github-mcp: docker not available')
    // BOUND the connect handshake (finding #7): without an app-level timeout a wedged daemon / a
    // server that never answers `initialize` stalls the spec-drafting critical path for up to the
    // SDK's ~60s default before falling back to RAG-only. Race the connect against initTimeoutMs;
    // on timeout we reject with the SAME fixed, token-free message so the caller degrades to honest
    // absence fast.
    let timer: { clear: () => void } | undefined
    let timedOut = false
    // Start the connect ONCE so the SAME promise feeds both the race and the late-arrival reaper —
    // a connect that resolves AFTER we've timed out yields an UNOWNED connection whose docker child
    // would orphan; close it best-effort so no token-bearing container survives.
    const connectPromise = this.connectFn(this.token, this.toolsets)
    connectPromise.then(
      conn => { if (timedOut) void closeConnQuietly(conn) },
      () => { /* connect rejected — nothing to reap */ },
    )
    try {
      this.conn = await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          timer = this.setTimer(() => {
            timedOut = true
            reject(new McpUnavailableError('github-mcp: server failed to start'))
          }, this.initTimeoutMs)
        }),
      ])
    } catch {
      // FIXED, token-free message — nothing from the underlying error is echoed.
      throw new McpUnavailableError('github-mcp: server failed to start')
    } finally {
      timer?.clear()
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    const conn = this.requireConn()
    const res = await conn.client.listTools()
    return res.tools.map(t => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object' },
    }))
  }

  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    const conn = this.requireConn()
    const res = await conn.client.callTool({ name, arguments: args })
    const text = (res.content ?? [])
      .map(c => (typeof c.text === 'string' ? c.text : ''))
      .filter(s => s.length > 0)
      .join('\n')
    return { text, isError: res.isError === true }
  }

  async close(): Promise<void> {
    if (this.closed) return // idempotent
    this.closed = true
    const conn = this.conn
    this.conn = undefined
    if (!conn) return
    // Close the MCP client first (flushes stdio); then SIGTERM→SIGKILL the docker child — a
    // closed stdio client does not guarantee `docker run` exits, so we kill it explicitly.
    //
    // BOUND client.close() (finding #8): the SDK client.close() awaits a stdio flush with NO
    // per-call timeout. A wedged flush would otherwise hang close() forever AND — because the kill
    // ran strictly AFTER the awaited close — leave killChild() (the REAL reaper) unreached, orphaning
    // the token-bearing docker child. So we race client.close() against a short timeout and ALWAYS
    // run killChild() afterwards regardless of whether the close resolved, rejected, or timed out.
    let timer: { clear: () => void } | undefined
    try {
      await Promise.race([
        conn.client.close().catch(() => {}),
        new Promise<void>(resolve => { timer = this.setTimer(resolve, this.initTimeoutMs) }),
      ])
    } catch {
      /* best-effort — we still kill the child below */
    } finally {
      timer?.clear()
    }
    try {
      conn.killChild?.()
    } catch {
      /* best-effort */
    }
  }

  private requireConn(): McpConnection {
    if (!this.conn) throw new McpUnavailableError('github-mcp: not initialized')
    return this.conn
  }
}

/** Close an UNOWNED connection (e.g. a connect that resolved AFTER initialize() timed out) so its
 *  docker child never orphans. Best-effort: close the client, then kill the child regardless. */
async function closeConnQuietly(conn: McpConnection): Promise<void> {
  try {
    await conn.client.close()
  } catch {
    /* best-effort */
  }
  try {
    conn.killChild?.()
  } catch {
    /* best-effort */
  }
}

/** Docker preflight: spawn `docker --version` directly (no shell). ENOENT ⇒ not on PATH.
 *  Mirrors PreviewRegistry.commandOnPath. BOUNDED by its own timeout (finding #7): `docker
 *  --version` is client-side and fast even with a wedged daemon, but a self-resolving timeout
 *  guarantees the preflight can never become the unbounded stall (it resolves false on timeout —
 *  treated as "absent" ⇒ honest degrade). */
async function defaultDockerOnPath(): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  return new Promise<boolean>(res => {
    let settled = false
    const done = (v: boolean): void => { if (!settled) { settled = true; res(v) } }
    const timer = setTimeout(() => done(false), 3_000)
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref()
    try {
      const p = spawn('docker', ['--version'], { stdio: 'ignore' })
      p.on('error', () => { clearTimeout(timer); done(false) })
      p.on('close', () => { clearTimeout(timer); done(true) })
    } catch {
      clearTimeout(timer)
      done(false)
    }
  })
}

/**
 * The real connect: build the SDK Client + StdioClientTransport via DYNAMIC import (keeps the
 * SDK out of every other module's import graph). The SDK transport OWNS the `docker run` spawn;
 * we pass the token ONLY through the env map. We also kill the docker child on close (the SDK
 * does not guarantee `docker run` exits when stdio closes).
 */
const defaultConnect = async (token: string, toolsets: string): Promise<McpConnection> => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

  const transport = new StdioClientTransport({
    command: 'docker',
    args: dockerArgs(),
    // Token via the env MAP only — NEVER argv, NEVER logged. buildSpawnEnv is the single, tested
    // source of this map (so the unit test asserts the EXACT object handed to the SDK here).
    env: buildSpawnEnv(token, toolsets),
    stderr: 'ignore',
  })

  const client = new Client({ name: 'akis-github-mcp', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)

  // The StdioClientTransport exposes the spawned child's pid; kill its process tree on close.
  const pid = (transport as { pid?: number }).pid
  const killChild = (): void => {
    if (pid === undefined) return
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
    setTimeout(() => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }, 2000).unref()
  }

  return {
    client: client as unknown as McpClientLike,
    killChild,
  }
}
