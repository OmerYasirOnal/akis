import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  StdioDockerTransport,
  dockerArgs,
  buildSpawnEnv,
  IMAGE,
  type McpConnection,
  type McpClientLike,
} from '../../src/agent/mcp/StdioDockerTransport.js'
import { McpUnavailableError } from '../../src/agent/mcp/McpTransport.js'

/**
 * StdioDockerTransport — unit tests with NO real Docker and NO real @modelcontextprotocol/sdk.
 *
 * The "concrete" transport's two hardest invariants are SECRET-SAFETY and the docker INVOCATION
 * SHAPE, both of which we can pin purely:
 *  - the docker argv (image pinned by digest, --read-only + hardening flags, `stdio`) carries NO
 *    token — dockerArgs() is pure and exported, so we assert it directly (the way the OpenSshTransport
 *    suite asserts the spawned ssh argv);
 *  - the token reaches the child ONLY via the env MAP under GITHUB_PERSONAL_ACCESS_TOKEN —
 *    buildSpawnEnv() is the single, exported source of that map (the real connect() hands the SDK the
 *    exact object this function returns), so asserting it here pins the production code path, not a copy.
 *
 * The lifecycle (initialize/listTools/callTool/close, the docker-missing degrade, the token-free
 * error contract) is driven through the module's own injection seams — a FAKE `connect` factory and a
 * FAKE `dockerOnPath` preflight — so neither Docker nor the SDK is ever touched. This mirrors how
 * OpenSshTransport is tested via an injected CommandOnPath + a mocked spawn.
 *
 * MINIMAL REFACTOR made to enable these tests (noted in the return): dockerArgs() and a new pure
 * buildSpawnEnv() were EXPORTED, and defaultConnect() rewired to call buildSpawnEnv() so the argv/env
 * construction (previously locked inside the SDK+Docker-only defaultConnect) is now unit-testable on
 * the SAME code the real connect runs.
 */

// A token that is trivially grep-able: if any single character of it appears in an error message or
// a captured log line, the secret-safety assertions below fail. Deliberately distinctive.
const TOKEN = 'ghp_THIS_TOKEN_MUST_NEVER_LEAK_0123456789abcdef'

// ── A FAKE MCP client + connection (no SDK, no Docker) ─────────────────────────────────────────
/** Records close()/listTools()/callTool() so we can assert ordering + normalization. */
interface FakeClientState {
  closed: number
  listToolsCalls: number
  callToolArgs: Array<{ name: string; arguments: unknown }>
}

function fakeClient(
  state: FakeClientState,
  opts: {
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
    callResult?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
    closeThrows?: boolean
  } = {},
): McpClientLike {
  return {
    async listTools() {
      state.listToolsCalls++
      return { tools: opts.tools ?? [] }
    },
    async callTool(args) {
      state.callToolArgs.push(args)
      return opts.callResult ?? { content: [] }
    },
    async close() {
      state.closed++
      if (opts.closeThrows) throw new Error('client close boom')
    },
  }
}

/** A connect factory that RECORDS the (token, toolsets) it was handed and resolves a fake conn. The
 *  recording lets us prove the constructor threads the decrypted token + toolsets through unchanged. */
function recordingConnect(conn: McpConnection): {
  connect: (token: string, toolsets: string) => Promise<McpConnection>
  calls: Array<{ token: string; toolsets: string }>
} {
  const calls: Array<{ token: string; toolsets: string }> = []
  return {
    calls,
    connect: async (token, toolsets) => {
      calls.push({ token, toolsets })
      return conn
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ── 1. The docker argv contract (pure, no spawn) ───────────────────────────────────────────────
describe('dockerArgs() — invocation + hardening shape, token-free', () => {
  it('pins the digest-locked image and runs the `stdio` subcommand', () => {
    const args = dockerArgs()
    // The pinned image is present as its own argv element, and `stdio` is the trailing subcommand.
    expect(args).toContain(IMAGE)
    expect(IMAGE).toMatch(/^ghcr\.io\/github\/github-mcp-server@sha256:[0-9a-f]{64}$/)
    expect(args[args.length - 1]).toBe('stdio')
  })

  it('pins a REAL digest, not the all-zeros placeholder (a placeholder can never resolve a GHCR manifest)', () => {
    // An all-zeros sha256 resolves to no manifest ⇒ docker run always fails ⇒ the feature is
    // non-functional AND the allow-list↔image correspondence is unproven. Guard against a
    // regression back to the placeholder.
    const digest = IMAGE.split('@sha256:')[1]
    expect(digest).toBeDefined()
    expect(digest).not.toMatch(/^0{64}$/)
  })

  it('carries `run -i --rm` and the untrusted-code hardening flags', () => {
    const args = dockerArgs()
    expect(args[0]).toBe('run')
    expect(args).toContain('-i')
    expect(args).toContain('--rm')
    // GATE/HARDENING: container filesystem read-only, all caps dropped, bounded pids/mem/cpu.
    expect(args).toContain('--read-only')
    expect(args).toContain('--cap-drop=ALL')
    expect(args).toContain('--pids-limit=256')
    expect(args).toContain('--memory=512m')
    expect(args).toContain('--cpus=1')
  })

  it('NEVER puts the token VALUE in argv — argv is world-visible via ps/proc', () => {
    // dockerArgs takes no token by design; assert the realized argv string is free of any token byte.
    const joined = dockerArgs().join(' ')
    expect(joined).not.toContain(TOKEN)
    expect(joined).not.toMatch(/ghp_/)
    // The `-e NAME` form puts the env-var NAME (not its value) in argv — assert there is NO
    // inline `=value` assignment that would smuggle a secret into argv (e.g. a `-e NAME=...` regression).
    expect(joined).not.toMatch(/GITHUB_PERSONAL_ACCESS_TOKEN\s*=/)
    expect(joined).not.toMatch(/=ghp_/)
  })

  it('passes the env vars to the container via the value-less `-e NAME` form (so values travel via the env map, not argv)', () => {
    // `docker run` does NOT inherit the CLI process env; without these -e flags the token +
    // GITHUB_READ_ONLY=1 (the read-only backstop) never reach the server (every call 401s, the
    // documented allow-list backstop is inert). The value-less form means docker reads each value
    // from the spawn env map (NOT argv) — value via env channel ONLY.
    const args = dockerArgs()
    // Each var appears as a `-e` flag immediately followed by the bare NAME (no `=value`).
    const expectFlagFor = (name: string): void => {
      const i = args.indexOf(name)
      expect(i).toBeGreaterThan(0) // present as its own argv element
      expect(args[i - 1]).toBe('-e') // preceded by -e (the value-less env-passthrough form)
      expect(name).not.toContain('=') // bare NAME, never an inline assignment
    }
    expectFlagFor('GITHUB_PERSONAL_ACCESS_TOKEN')
    expectFlagFor('GITHUB_READ_ONLY')
    expectFlagFor('GITHUB_TOOLSETS')
    // buildSpawnEnv() carries the MATCHING keys, so the values docker reads-by-name actually exist.
    const env = buildSpawnEnv(TOKEN, 'repos,issues,pull_requests')
    for (const name of ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_READ_ONLY', 'GITHUB_TOOLSETS']) {
      expect(Object.prototype.hasOwnProperty.call(env, name)).toBe(true)
    }
  })
})

// ── 2. The env map contract (pure, no spawn) ───────────────────────────────────────────────────
describe('buildSpawnEnv() — token travels ONLY here, under the right var', () => {
  it('places the decrypted token under GITHUB_PERSONAL_ACCESS_TOKEN and nowhere else', () => {
    const env = buildSpawnEnv(TOKEN, 'repos,issues')
    expect(env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe(TOKEN)
    // The token must be the value of EXACTLY that one var — not duplicated under another key.
    const keysHoldingToken = Object.keys(env).filter(k => env[k] === TOKEN)
    expect(keysHoldingToken).toEqual(['GITHUB_PERSONAL_ACCESS_TOKEN'])
  })

  it('forces read-only on the server and threads the toolsets through', () => {
    const env = buildSpawnEnv(TOKEN, 'repos,issues,pull_requests')
    // GATE: GITHUB_READ_ONLY=1 is belt-and-suspenders with the bridge allow-list.
    expect(env.GITHUB_READ_ONLY).toBe('1')
    expect(env.GITHUB_TOOLSETS).toBe('repos,issues,pull_requests')
  })

  it('does NOT leak the token into any env KEY (keys reach logs more readily than values)', () => {
    const env = buildSpawnEnv(TOKEN, 'repos')
    for (const k of Object.keys(env)) expect(k).not.toContain(TOKEN)
  })
})

// ── 3. The constructor threads token + toolsets into connect() ─────────────────────────────────
describe('StdioDockerTransport.initialize() — wiring + idempotency', () => {
  it('hands the decrypted token + default toolsets to the injected connect factory', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const rec = recordingConnect({ client: fakeClient(state) })
    const t = new StdioDockerTransport({ token: TOKEN, connect: rec.connect, dockerOnPath: async () => true })
    await t.initialize()
    expect(rec.calls).toHaveLength(1)
    expect(rec.calls[0]!.token).toBe(TOKEN)
    // Default toolsets when the caller does not override.
    expect(rec.calls[0]!.toolsets).toBe('repos,issues,pull_requests')
    await t.close()
  })

  it('passes a caller-supplied toolsets override through to connect', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const rec = recordingConnect({ client: fakeClient(state) })
    const t = new StdioDockerTransport({ token: TOKEN, toolsets: 'repos', connect: rec.connect, dockerOnPath: async () => true })
    await t.initialize()
    expect(rec.calls[0]!.toolsets).toBe('repos')
    await t.close()
  })

  it('is idempotent — a second initialize() does NOT spawn/connect a second child', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const rec = recordingConnect({ client: fakeClient(state) })
    const t = new StdioDockerTransport({ token: TOKEN, connect: rec.connect, dockerOnPath: async () => true })
    await t.initialize()
    await t.initialize()
    expect(rec.calls).toHaveLength(1) // one connection per lifetime
    await t.close()
  })
})

// ── 4. GRACEFUL DEGRADE: docker missing / preflight error / connect failure → typed unavailability ─
describe('StdioDockerTransport.initialize() — honest absence, never a crash', () => {
  it('no docker on PATH ⇒ McpUnavailableError (connect never even attempted)', async () => {
    const rec = recordingConnect({ client: fakeClient({ closed: 0, listToolsCalls: 0, callToolArgs: [] }) })
    const t = new StdioDockerTransport({ token: TOKEN, connect: rec.connect, dockerOnPath: async () => false })
    await expect(t.initialize()).rejects.toBeInstanceOf(McpUnavailableError)
    expect(rec.calls).toHaveLength(0) // short-circuited at the preflight — no spawn attempt
  })

  it('a THROWING docker preflight is treated as "absent", not a crash', async () => {
    const rec = recordingConnect({ client: fakeClient({ closed: 0, listToolsCalls: 0, callToolArgs: [] }) })
    const t = new StdioDockerTransport({
      token: TOKEN,
      connect: rec.connect,
      dockerOnPath: async () => {
        throw new Error('spawn EACCES')
      },
    })
    await expect(t.initialize()).rejects.toBeInstanceOf(McpUnavailableError)
    expect(rec.calls).toHaveLength(0)
  })

  it('a connect() failure surfaces a FIXED, token-free McpUnavailableError (nothing echoed)', async () => {
    const t = new StdioDockerTransport({
      token: TOKEN,
      dockerOnPath: async () => true,
      // The underlying error CARRIES the token (a worst case: e.g. an env dump in the message). The
      // re-thrown error must echo NONE of it — fixed message only.
      connect: async () => {
        throw new Error(`server boot failed with env GITHUB_PERSONAL_ACCESS_TOKEN=${TOKEN}`)
      },
    })
    await expect(t.initialize()).rejects.toBeInstanceOf(McpUnavailableError)
    await expect(t.initialize()).rejects.toThrow('github-mcp: server failed to start')
  })
})

// ── 4b. BOUNDED initialize() — a wedged connect can't stall the Scribe critical path (finding #7) ─
describe('StdioDockerTransport.initialize() — bounded by an app-level timeout', () => {
  /** A controllable fake timer matching the transport's injected `setTimer` shape: the test fires
   *  the timeout deterministically so a "never-settling connect" is bounded with no real wall-clock. */
  function fakeInitTimer(): { setTimer: (cb: () => void, ms: number) => { clear: () => void }; fire: () => void; armedMs: number | undefined } {
    let pending: (() => void) | undefined
    let armedMs: number | undefined
    return {
      setTimer: (cb, ms) => { pending = cb; armedMs = ms; return { clear: () => { pending = undefined } } },
      fire: () => pending?.(),
      get armedMs() { return armedMs },
    }
  }

  it('a connect that NEVER settles is bounded: the timeout rejects with the fixed token-free error', async () => {
    const clock = fakeInitTimer()
    const t = new StdioDockerTransport({
      token: TOKEN,
      dockerOnPath: async () => true,
      // A wedged daemon / a server that never answers `initialize`: connect never resolves.
      connect: () => new Promise<McpConnection>(() => {}),
      initTimeoutMs: 10_000,
      setTimer: clock.setTimer,
    })
    const p = t.initialize().then(() => null, e => e as Error)
    // initialize() awaits the docker preflight (a microtask) before arming the connect bound — let
    // those microtasks flush so the timer is armed before we inspect/fire it.
    await Promise.resolve(); await Promise.resolve()
    expect(clock.armedMs).toBe(10_000) // armed for exactly the configured bound
    clock.fire() // the app-level timeout elapses
    const err = await p
    expect(err).toBeInstanceOf(McpUnavailableError)
    expect(err!.message).toBe('github-mcp: server failed to start')
    expect(err!.message).not.toContain(TOKEN)
  })

  it('a fast connect WINS the race and the bound never fires (clean init unaffected)', async () => {
    const clock = fakeInitTimer()
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const t = new StdioDockerTransport({
      token: TOKEN,
      dockerOnPath: async () => true,
      connect: async () => ({ client: fakeClient(state) }),
      initTimeoutMs: 10_000,
      setTimer: clock.setTimer,
    })
    await expect(t.initialize()).resolves.toBeUndefined()
    // Even if a stale timeout fired now, init already resolved — must not corrupt the live conn.
    clock.fire()
    await expect(t.listTools()).resolves.toEqual([])
    await t.close()
  })

  it('a connect that resolves AFTER the timeout is reaped (its docker child is not orphaned)', async () => {
    const clock = fakeInitTimer()
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    let killed = 0
    let resolveLate: (c: McpConnection) => void = () => {}
    const t = new StdioDockerTransport({
      token: TOKEN,
      dockerOnPath: async () => true,
      connect: () => new Promise<McpConnection>(resolve => { resolveLate = resolve }),
      initTimeoutMs: 5_000,
      setTimer: clock.setTimer,
    })
    const p = t.initialize().then(() => null, e => e as Error)
    // Let the preflight microtask flush so the connect bound is armed before we fire it.
    await Promise.resolve(); await Promise.resolve()
    clock.fire() // timeout wins the race first
    const err = await p
    expect(err).toBeInstanceOf(McpUnavailableError)
    // The connect resolves LATE — its connection is unowned and must be closed + child reaped.
    resolveLate({ client: fakeClient(state), killChild: () => { killed++ } })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(state.closed).toBe(1) // late connection's client was closed
    expect(killed).toBe(1) // and its docker child reaped — no orphan
  })
})

// ── 5. listTools / callTool normalization (off the FAKE client wire shape) ──────────────────────
describe('StdioDockerTransport.listTools() / callTool() — normalization off the SDK shape', () => {
  it('normalizes tools, defaulting a missing description + inputSchema', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const client = fakeClient(state, {
      tools: [
        { name: 'get_file_contents', description: 'read a file', inputSchema: { type: 'object', properties: {} } },
        { name: 'list_commits' }, // no description, no inputSchema — must get safe defaults
      ],
    })
    const t = new StdioDockerTransport({ token: TOKEN, connect: async () => ({ client }), dockerOnPath: async () => true })
    await t.initialize()
    const tools = await t.listTools()
    expect(tools).toHaveLength(2)
    expect(tools[0]).toEqual({
      name: 'get_file_contents',
      description: 'read a file',
      inputSchema: { type: 'object', properties: {} },
    })
    // Defaults: empty description, an object schema (so the LLM still gets a valid schema).
    expect(tools[1]!.description).toBe('')
    expect(tools[1]!.inputSchema).toEqual({ type: 'object' })
    await t.close()
  })

  it('callTool flattens the content blocks into one text payload + the error flag', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const client = fakeClient(state, {
      callResult: {
        content: [
          { type: 'text', text: 'line one' },
          { type: 'text' }, // no text — dropped
          { type: 'text', text: '' }, // empty — dropped
          { type: 'text', text: 'line two' },
        ],
        isError: false,
      },
    })
    const t = new StdioDockerTransport({ token: TOKEN, connect: async () => ({ client }), dockerOnPath: async () => true })
    await t.initialize()
    const res = await t.callTool('get_file_contents', { owner: 'a', repo: 'b' })
    expect(res.text).toBe('line one\nline two')
    expect(res.isError).toBe(false)
    // The args reached the client verbatim.
    expect(state.callToolArgs).toEqual([{ name: 'get_file_contents', arguments: { owner: 'a', repo: 'b' } }])
    await t.close()
  })

  it('propagates a server-side isError, coercing it to a strict boolean', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    const client = fakeClient(state, { callResult: { content: [{ type: 'text', text: 'nope' }], isError: true } })
    const t = new StdioDockerTransport({ token: TOKEN, connect: async () => ({ client }), dockerOnPath: async () => true })
    await t.initialize()
    const res = await t.callTool('x', {})
    expect(res).toEqual({ text: 'nope', isError: true })
    await t.close()
  })

  it('listTools/callTool before initialize() throw a typed unavailability (not a raw null deref)', async () => {
    const t = new StdioDockerTransport({ token: TOKEN, connect: async () => ({ client: fakeClient({ closed: 0, listToolsCalls: 0, callToolArgs: [] }) }), dockerOnPath: async () => true })
    await expect(t.listTools()).rejects.toBeInstanceOf(McpUnavailableError)
    await expect(t.callTool('x', {})).rejects.toBeInstanceOf(McpUnavailableError)
  })
})

// ── 6. close(): client first, then the docker child; idempotent + best-effort ──────────────────
describe('StdioDockerTransport.close() — tears down client + owned child, idempotent', () => {
  it('closes the MCP client AND kills the docker child, exactly once', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    let killed = 0
    const t = new StdioDockerTransport({
      token: TOKEN,
      connect: async () => ({ client: fakeClient(state), killChild: () => { killed++ } }),
      dockerOnPath: async () => true,
    })
    await t.initialize()
    await t.close()
    expect(state.closed).toBe(1)
    expect(killed).toBe(1) // a closed stdio client does NOT guarantee `docker run` exits — kill it
    // Idempotent: a second close() does NOT double-close / double-kill.
    await t.close()
    expect(state.closed).toBe(1)
    expect(killed).toBe(1)
  })

  it('still kills the docker child even if client.close() throws (best-effort teardown)', async () => {
    const state: FakeClientState = { closed: 0, listToolsCalls: 0, callToolArgs: [] }
    let killed = 0
    const t = new StdioDockerTransport({
      token: TOKEN,
      connect: async () => ({ client: fakeClient(state, { closeThrows: true }), killChild: () => { killed++ } }),
      dockerOnPath: async () => true,
    })
    await t.initialize()
    await expect(t.close()).resolves.toBeUndefined() // does not reject
    expect(killed).toBe(1) // child still reaped despite the client.close throw
  })

  it('close() before initialize() is a safe no-op', async () => {
    const t = new StdioDockerTransport({ token: TOKEN, connect: async () => ({ client: fakeClient({ closed: 0, listToolsCalls: 0, callToolArgs: [] }) }), dockerOnPath: async () => true })
    await expect(t.close()).resolves.toBeUndefined()
  })

  it('finding #8: a HANGING client.close() cannot block close() — killChild STILL reaps the child', async () => {
    // The SDK client.close() flush has no timeout; a wedged flush would otherwise hang close()
    // forever AND skip killChild() (the real reaper, gated behind the awaited close). close() races
    // client.close() against the bound and ALWAYS runs killChild — so the docker child is reaped.
    let killed = 0
    let pending: (() => void) | undefined
    const clock = { setTimer: (cb: () => void, _ms: number) => { pending = cb; return { clear: () => { pending = undefined } } } }
    const hangingClient: McpClientLike = {
      async listTools() { return { tools: [] } },
      async callTool() { return { content: [] } },
      close: () => new Promise<void>(() => {}), // never resolves (wedged stdio flush)
    }
    const t = new StdioDockerTransport({
      token: TOKEN,
      dockerOnPath: async () => true,
      connect: async () => ({ client: hangingClient, killChild: () => { killed++ } }),
      initTimeoutMs: 5_000,
      setTimer: clock.setTimer,
    })
    await t.initialize()
    const p = t.close()
    pending?.() // the close-bound timeout elapses — abandon the hung client.close()
    await expect(p).resolves.toBeUndefined() // close() settled despite the hang
    expect(killed).toBe(1) // the docker child was STILL reaped — no orphan
  })
})

// ── 7. SECRETS: the token must NEVER appear in any error message OR any log line the module emits ─
describe('StdioDockerTransport — the token never appears in an error message or a log line', () => {
  /** Capture EVERY console channel — the module must not log the token on any path. */
  function captureConsole(): { lines: string[]; restore: () => void } {
    const lines: string[] = []
    const sink = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')) }
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(sink),
      vi.spyOn(console, 'info').mockImplementation(sink),
      vi.spyOn(console, 'warn').mockImplementation(sink),
      vi.spyOn(console, 'error').mockImplementation(sink),
      vi.spyOn(console, 'debug').mockImplementation(sink),
    ]
    return { lines, restore: () => spies.forEach(s => s.mockRestore()) }
  }

  it('a connect failure whose underlying error CARRIES the token leaks NOTHING (msg + logs clean)', async () => {
    const cap = captureConsole()
    try {
      const t = new StdioDockerTransport({
        token: TOKEN,
        dockerOnPath: async () => true,
        connect: async () => { throw new Error(`boom GITHUB_PERSONAL_ACCESS_TOKEN=${TOKEN} env-dump`) },
      })
      const err = await t.initialize().then(() => null, e => e as Error)
      expect(err).toBeInstanceOf(McpUnavailableError)
      // The message echoes NOTHING of the underlying error.
      expect(err!.message).not.toContain(TOKEN)
      expect(err!.message).toBe('github-mcp: server failed to start')
      // The stack (which CWriter could log) must also be token-free.
      expect(String(err!.stack ?? '')).not.toContain(TOKEN)
    } finally {
      cap.restore()
    }
    expect(cap.lines.join('\n')).not.toContain(TOKEN)
  })

  it('the docker-missing path produces a token-free error + no log line', async () => {
    const cap = captureConsole()
    try {
      const t = new StdioDockerTransport({ token: TOKEN, dockerOnPath: async () => false, connect: async () => ({ client: fakeClient({ closed: 0, listToolsCalls: 0, callToolArgs: [] }) }) })
      const err = await t.initialize().then(() => null, e => e as Error)
      expect(err!.message).not.toContain(TOKEN)
    } finally {
      cap.restore()
    }
    expect(cap.lines.join('\n')).not.toContain(TOKEN)
  })

  it('the not-initialized error (requireConn) is token-free', async () => {
    const t = new StdioDockerTransport({ token: TOKEN, connect: async () => ({ client: fakeClient({ closed: 0, listToolsCalls: 0, callToolArgs: [] }) }), dockerOnPath: async () => true })
    const err = await t.callTool('x', {}).then(() => null, e => e as Error)
    expect(err).toBeInstanceOf(McpUnavailableError)
    expect(err!.message).not.toContain(TOKEN)
  })
})
