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

/** github-mcp-server, pinned by sha256 digest (supply-chain). The tag the DIGEST resolves to
 *  is the one the read-only allow-list (readOnlyAllowlist.ts) was rebuilt against. */
export const IMAGE =
  'ghcr.io/github/github-mcp-server@sha256:0000000000000000000000000000000000000000000000000000000000000000'

/** The hardening + invocation argv for the `docker run` child. The token is NOT here — it is
 *  passed via the env map only. shell:false is implicit (StdioClientTransport spawns directly). */
function dockerArgs(): string[] {
  return [
    'run',
    '-i',
    '--rm',
    '--read-only',
    '--cap-drop=ALL',
    '--pids-limit=256',
    '--memory=512m',
    '--cpus=1',
    IMAGE,
    'stdio',
  ]
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
}

export class StdioDockerTransport implements McpTransport {
  private readonly token: string
  private readonly toolsets: string
  private readonly connectFn: (token: string, toolsets: string) => Promise<McpConnection>
  private readonly dockerOnPath: () => Promise<boolean>
  private conn: McpConnection | undefined
  private closed = false

  constructor(opts: StdioDockerTransportOptions) {
    this.token = opts.token
    this.toolsets = opts.toolsets ?? 'repos,issues,pull_requests'
    this.connectFn = opts.connect ?? defaultConnect
    this.dockerOnPath = opts.dockerOnPath ?? defaultDockerOnPath
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
    try {
      this.conn = await this.connectFn(this.token, this.toolsets)
    } catch {
      // FIXED, token-free message — nothing from the underlying error is echoed.
      throw new McpUnavailableError('github-mcp: server failed to start')
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
    try {
      await conn.client.close()
    } catch {
      /* best-effort — we still kill the child below */
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

/** Docker preflight: spawn `docker --version` directly (no shell). ENOENT ⇒ not on PATH.
 *  Mirrors PreviewRegistry.commandOnPath. */
async function defaultDockerOnPath(): Promise<boolean> {
  const { spawn } = await import('node:child_process')
  return new Promise<boolean>(res => {
    const p = spawn('docker', ['--version'], { stdio: 'ignore' })
    p.on('error', () => res(false))
    p.on('close', () => res(true))
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
    // Token via the env MAP only — NEVER argv, NEVER logged.
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: token,
      GITHUB_READ_ONLY: '1',
      GITHUB_TOOLSETS: toolsets,
    },
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
