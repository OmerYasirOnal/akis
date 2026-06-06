import { describe, it, expect } from 'vitest'
import { buildGithubMcpTools, type GithubMcpDeps } from '../../src/agent/tools/githubMcpTools.js'
import { buildAdvisoryToolsWithGithub } from '../../src/agent/tools/advisoryTools.js'
import { McpSessionPool, type McpTransportFactory } from '../../src/agent/mcp/McpSessionPool.js'
import { McpUnavailableError, type McpTransport, type McpToolInfo, type McpToolResult } from '../../src/agent/mcp/McpTransport.js'
import { GITHUB_READONLY_TOOLS } from '../../src/agent/mcp/readOnlyAllowlist.js'
import { ScribeAgent } from '../../src/orchestrator/subagents/ScribeAgent.js'
import { EventBus } from '../../src/events/bus.js'
import type { KnowledgePort, RetrieveQuery } from '../../src/knowledge/KnowledgePort.js'
import type { LlmProvider, ChatResult } from '../../src/agent/LlmProvider.js'
import type { KnowledgeChunk, AkisEvent } from '@akis/shared'

/**
 * Unit tests for the READ-ONLY GitHub-via-MCP TOOL-BUILD layer: githubMcpTools.ts
 * (the just-in-time bridge wiring) + its two callers' diffs — buildAdvisoryToolsWithGithub
 * (advisoryTools.ts) and ScribeAgent.compose (ScribeAgent.ts).
 *
 * FAKE transports only — NO Docker, NO network (HARD CONSTRAINT 4). We drive a REAL
 * McpSessionPool (the legitimate seam githubMcpTools talks to) with a fake transport
 * FACTORY, so the production acquire/release/refcount/idle path is exercised end-to-end
 * while every transport is an in-memory fake. The four locked pins are each asserted:
 *  1. tools only built when the owner HAS a connection (no deps.githubMcp ⇒ absent, no crash);
 *  2. the decrypted token flows to the pool/factory and NOWHERE else (never into a spec/handler);
 *  3. Scribe receives the github tools ALONGSIDE retrieve_knowledge without disturbing it;
 *  4. an McpUnavailableError during build ⇒ empty tools + a non-secret diagnostic, never a crash.
 */

const SECRET = 'gho_super_secret_token_value_42'

/** A fully in-memory McpTransport. Records every callTool name so we can assert that ONLY
 *  the underlying (un-namespaced) tool name is sent over the wire, and lets a test inject
 *  failures at initialize/listTools/callTool to exercise the degrade paths. */
class FakeTransport implements McpTransport {
  initCount = 0
  listCount = 0
  closeCount = 0
  readonly callLog: Array<{ name: string; args: unknown }> = []
  constructor(
    private readonly cfg: {
      advertise?: McpToolInfo[]
      onInit?: () => void
      onList?: () => void
      callResult?: (name: string, args: unknown) => McpToolResult | Promise<McpToolResult>
    } = {},
  ) {}
  async initialize(): Promise<void> {
    this.initCount++
    this.cfg.onInit?.()
  }
  async listTools(): Promise<McpToolInfo[]> {
    this.listCount++
    this.cfg.onList?.()
    return this.cfg.advertise ?? []
  }
  async callTool(name: string, args: unknown): Promise<McpToolResult> {
    this.callLog.push({ name, args })
    if (this.cfg.callResult) return this.cfg.callResult(name, args)
    return { text: `result for ${name}`, isError: false }
  }
  async close(): Promise<void> {
    this.closeCount++
  }
}

/** A tool the github-mcp-server actually advertises under the read toolsets (allow-listed). */
const READ_TOOL: McpToolInfo = {
  name: 'get_file_contents',
  description: 'Read a file from the repo.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
}
/** A WRITE/mutation tool the bridge must STRUCTURALLY drop (not on the positive allow-list). */
const WRITE_TOOL: McpToolInfo = {
  name: 'push_files',
  description: 'Push files to the repo.',
  inputSchema: { type: 'object' },
}

/** A controllable fake timer matching the pool's injected `setTimer` shape — armed timers are
 *  captured so a test fires them on demand (the idle-teardown escape hatch) with NO real wall-clock,
 *  so the ref-held-across-loop guarantee (findings #4/#6) is deterministic offline. */
function fakeClock(): {
  setTimer: (cb: () => void, ms: number) => { cancel: () => void }
  tick: () => void
} {
  interface Armed { cb: () => void; fired: boolean; cancelled: boolean }
  const armed: Armed[] = []
  return {
    setTimer: cb => {
      const a: Armed = { cb, fired: false, cancelled: false }
      armed.push(a)
      return { cancel: () => { a.cancelled = true } }
    },
    tick: () => {
      for (const a of armed) {
        if (!a.cancelled && !a.fired) { a.fired = true; a.cb() }
      }
    },
  }
}

/** Build a pool whose factory hands back the SAME provided transport (so a test can inspect it),
 *  AND records the (ownerId, token) material the factory receives — the pin-2 token-flow probe.
 *  Default timer is a no-op (an armed idle teardown never fires); a test that needs to fire the
 *  idle timer injects a controllable `setTimer` (fakeClock) so it controls the teardown moment. */
function poolWith(
  transport: McpTransport,
  setTimer: (cb: () => void, ms: number) => { cancel: () => void } = () => ({ cancel: () => {} }),
): {
  pool: McpSessionPool
  factoryCalls: Array<{ ownerId: string; token: string }>
} {
  const factoryCalls: Array<{ ownerId: string; token: string }> = []
  const factory: McpTransportFactory = material => {
    factoryCalls.push({ ownerId: material.ownerId, token: material.token })
    return transport
  }
  const pool = new McpSessionPool({ factory, setTimer })
  return { pool, factoryCalls }
}

/** A diagnostic sink that captures every non-secret degrade reason for inspection. */
function diagSink(): { msgs: string[]; diag: (m: string) => void } {
  const msgs: string[] = []
  return { msgs, diag: m => msgs.push(m) }
}

// ─────────────────────────────────────────────────────────────────────────────
// githubMcpTools.buildGithubMcpTools — the just-in-time bridge wiring
// ─────────────────────────────────────────────────────────────────────────────
describe('buildGithubMcpTools', () => {
  it('bridges ONLY allow-listed reads into namespaced github_ tools, dropping write tools', async () => {
    const t = new FakeTransport({ advertise: [READ_TOOL, WRITE_TOOL] })
    const { pool } = poolWith(t)
    const { msgs, diag } = diagSink()

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'owner-1', token: SECRET, diag })

    // The write tool is structurally absent; the read tool surfaces under the github_ namespace.
    expect(tools.map(x => x.spec.name)).toEqual(['github_get_file_contents'])
    // GATE-SAFETY: push_files can NEVER register, independent of any server flag.
    expect(tools.some(x => x.spec.name.includes('push'))).toBe(false)
    // A loud, NAME-ONLY drop diagnostic was emitted for the non-allowlisted tool.
    expect(msgs.some(m => m.includes('push_files') && m.includes('dropped'))).toBe(true)
  })

  it('PIN 2: the decrypted token flows to the pool factory and NOWHERE into the built tools', async () => {
    const t = new FakeTransport({ advertise: [READ_TOOL] })
    const { pool, factoryCalls } = poolWith(t)
    const { msgs, diag } = diagSink()

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'owner-1', token: SECRET, diag })

    // The token reached the pool's factory (the ONE place it legitimately flows) with the owner.
    expect(factoryCalls).toEqual([{ ownerId: 'owner-1', token: SECRET }])
    // The token must NEVER appear in a tool spec (name/description/schema) handed to the model…
    const specBlob = JSON.stringify(tools.map(x => x.spec))
    expect(specBlob).not.toContain(SECRET)
    // …nor in any diagnostic line (secrets never logged).
    expect(msgs.join('\n')).not.toContain(SECRET)
  })

  it('the bridged handler calls the UNDERLYING tool name (un-namespaced), never leaking the token in args', async () => {
    const t = new FakeTransport({ advertise: [READ_TOOL], callResult: () => ({ text: 'FILE CONTENTS', isError: false }) })
    const { pool } = poolWith(t)

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET })
    const tool = tools[0]
    expect(tool).toBeDefined()
    const out = await tool!.handler({ path: 'README.md' })

    expect(out).toBe('FILE CONTENTS')
    // Over the wire it is `get_file_contents`, NOT the `github_` display name.
    expect(t.callLog).toEqual([{ name: 'get_file_contents', args: { path: 'README.md' } }])
    // The token is not threaded into tool args.
    expect(JSON.stringify(t.callLog)).not.toContain(SECRET)
  })

  it('a callTool reject degrades to an Error STRING (never throws into the tool loop)', async () => {
    const t = new FakeTransport({
      advertise: [READ_TOOL],
      callResult: () => { throw new Error('rate limited') },
    })
    const { pool } = poolWith(t)
    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET })

    const out = await tools[0]!.handler({})
    expect(out).toMatch(/error calling github tool/i)
    expect(out).toContain('get_file_contents')
  })

  it('PIN 4: an McpUnavailableError on acquire ⇒ empty tools + a no-docker diagnostic, NEVER a crash', async () => {
    // initialize() rejecting with McpUnavailableError simulates "no Docker" — the pool re-throws
    // out of acquire(), and buildGithubMcpTools must swallow it into honest absence.
    const t = new FakeTransport({ onInit: () => { throw new McpUnavailableError('github-mcp: docker not found') } })
    const { pool } = poolWith(t)
    const { msgs, diag } = diagSink()

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET, diag })

    expect(tools).toEqual([])
    expect(msgs.some(m => m.includes('unavailable') && m.includes('no-docker'))).toBe(true)
    // GRACEFUL DEGRADE: never the token in the diagnostic, even on failure.
    expect(msgs.join('\n')).not.toContain(SECRET)
  })

  it('a generic (non-McpUnavailable) acquire failure ⇒ empty tools + a connection-absent diagnostic', async () => {
    const t = new FakeTransport({ onInit: () => { throw new Error('boom') } })
    const { pool } = poolWith(t)
    const { msgs, diag } = diagSink()

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET, diag })

    expect(tools).toEqual([])
    expect(msgs.some(m => m.includes('connection-absent'))).toBe(true)
  })

  it('an McpUnavailableError WITHOUT "docker" in the message maps to server-error', async () => {
    const t = new FakeTransport({ onInit: () => { throw new McpUnavailableError() } })
    const { pool } = poolWith(t)
    const { msgs, diag } = diagSink()

    expect((await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET, diag })).tools).toEqual([])
    expect(msgs.some(m => m.includes('server-error'))).toBe(true)
  })

  it('a listTools failure ⇒ empty tools (bridge swallows it), never a crash', async () => {
    const t = new FakeTransport({ onList: () => { throw new Error('list failed') } })
    const { pool } = poolWith(t)
    const { msgs, diag } = diagSink()

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET, diag })
    expect(tools).toEqual([])
  })

  it('an empty allow-list intersection ⇒ empty tools + an empty-intersection diagnostic', async () => {
    // Server advertises ONLY a write tool — nothing on the positive read allow-list survives.
    const t = new FakeTransport({ advertise: [WRITE_TOOL] })
    const { pool } = poolWith(t)
    const { msgs, diag } = diagSink()

    const { tools } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET, diag })
    expect(tools).toEqual([])
    expect(msgs.some(m => m.includes('empty-intersection'))).toBe(true)
  })

  it('HOLDS the ref across the loop: idle teardown CANNOT fire mid-loop (findings #4/#6), released on disposer', async () => {
    // The build acquires once and does NOT release at build time — it returns a `release` disposer
    // the caller invokes AFTER the tool loop. So the idle timer can never fire and close the live
    // Docker child WHILE a handler still holds the captured transport.
    const clock = fakeClock()
    const t = new FakeTransport({ advertise: [READ_TOOL] })
    const { pool } = poolWith(t, clock.setTimer)

    const { tools, release } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET })
    expect(t.initCount).toBe(1)
    expect(t.closeCount).toBe(0)
    // The ref is STILL HELD after the build: firing the idle clock must NOT close the transport.
    clock.tick()
    await Promise.resolve()
    expect(t.closeCount).toBe(0) // refcount > 0 keeps it alive — no mid-loop teardown
    // The handler works (the live transport is intact).
    expect(await tools[0]!.handler({})).toBe('result for get_file_contents')
    expect(t.closeCount).toBe(0)
    // After the loop the caller releases — NOW the idle timer arms and a tick tears it down.
    release()
    clock.tick()
    await Promise.resolve()
    expect(t.closeCount).toBe(1)
    // release() is idempotent — a double-call must not drive the refcount negative / re-close.
    release()
  })

  it('the no-tools (empty-intersection) path releases its ref immediately and hands back a no-op disposer', async () => {
    // With no tools there is no loop to keep the ref alive — buildGithubMcpTools releases NOW, so
    // the transport tears down on its normal idle schedule (the disposer the caller gets is inert).
    const clock = fakeClock()
    const t = new FakeTransport({ advertise: [WRITE_TOOL] }) // nothing survives the allow-list
    const { pool } = poolWith(t, clock.setTimer)

    const { tools, release } = await buildGithubMcpTools({ pool, ownerId: 'o', token: SECRET })
    expect(tools).toEqual([])
    // The build released its ref already ⇒ an idle timer is armed; ticking tears the idle transport down.
    clock.tick()
    await Promise.resolve()
    expect(t.closeCount).toBe(1)
    // The returned disposer is the no-op — calling it does not double-release (no throw, no re-close).
    release()
    expect(t.closeCount).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// advisoryTools.buildAdvisoryToolsWithGithub — the caller-side merge + fail-closed
// ─────────────────────────────────────────────────────────────────────────────
function knowledgePort(chunks: KnowledgeChunk[] = [], onQuery?: (q: RetrieveQuery) => void): KnowledgePort {
  return { async retrieve(q) { onQuery?.(q); return chunks } }
}

describe('buildAdvisoryToolsWithGithub', () => {
  it('PIN 1: NO deps.githubMcp ⇒ byte-identical RAG-only registry (no github tools, no crash)', async () => {
    const { registry: reg, release } = await buildAdvisoryToolsWithGithub(new Set(['retrieve_knowledge']), {
      knowledge: knowledgePort(),
      sessionId: 's1',
    })
    expect(reg.specs().map(s => s.name)).toEqual(['retrieve_knowledge'])
    // RAG-only path ⇒ the disposer is a safe no-op (callable without a held ref).
    expect(() => release()).not.toThrow()
  })

  it('PIN 3: a connection ⇒ retrieve_knowledge AND the github_ read tools coexist', async () => {
    const t = new FakeTransport({ advertise: [READ_TOOL] })
    const { pool } = poolWith(t)
    const { registry: reg, release } = await buildAdvisoryToolsWithGithub(new Set(['retrieve_knowledge']), {
      knowledge: knowledgePort(),
      sessionId: 's1',
      githubMcp: { pool, ownerId: 'o', token: SECRET, diag: () => {} },
    })
    const names = reg.specs().map(s => s.name).sort()
    expect(names).toEqual(['github_get_file_contents', 'retrieve_knowledge'])
    // retrieve_knowledge is UNDISTURBED — it still dispatches via the registry.
    expect(reg.has('retrieve_knowledge')).toBe(true)
    release()
  })

  it('REF-HELD-ACROSS-LOOP: the github ref survives until release() — idle teardown cannot fire mid-loop', async () => {
    const clock = fakeClock()
    const t = new FakeTransport({ advertise: [READ_TOOL] })
    const { pool } = poolWith(t, clock.setTimer)
    const { registry: reg, release } = await buildAdvisoryToolsWithGithub(new Set(['retrieve_knowledge']), {
      knowledge: knowledgePort(),
      sessionId: 's1',
      githubMcp: { pool, ownerId: 'o', token: SECRET, diag: () => {} },
    })
    // The ref is held across the (would-be) loop: a fired idle timer must NOT close the transport.
    clock.tick()
    await Promise.resolve()
    expect(t.closeCount).toBe(0)
    // The bridged github handler still works (the live transport is intact).
    const gh = reg.specs().find(s => s.name === 'github_get_file_contents')
    expect(gh).toBeDefined()
    expect(await reg.call('github_get_file_contents', {})).toBe('result for get_file_contents')
    // Loop done ⇒ release ⇒ now the idle timer arms and tears it down.
    release()
    clock.tick()
    await Promise.resolve()
    expect(t.closeCount).toBe(1)
  })

  it('honors the capability gate: without retrieve_knowledge cap, only github_ tools register', async () => {
    const t = new FakeTransport({ advertise: [READ_TOOL] })
    const { pool } = poolWith(t)
    const { registry: reg, release } = await buildAdvisoryToolsWithGithub(new Set<string>(), {
      knowledge: knowledgePort(),
      sessionId: 's1',
      githubMcp: { pool, ownerId: 'o', token: SECRET, diag: () => {} },
    })
    expect(reg.specs().map(s => s.name)).toEqual(['github_get_file_contents'])
    release()
  })

  it('PIN 4 (caller): an MCP-unavailable connection ⇒ fail-closed to the RAG-only registry, no crash', async () => {
    const t = new FakeTransport({ onInit: () => { throw new McpUnavailableError('docker missing') } })
    const { pool } = poolWith(t)
    const { registry: reg, release } = await buildAdvisoryToolsWithGithub(new Set(['retrieve_knowledge']), {
      knowledge: knowledgePort(),
      sessionId: 's1',
      githubMcp: { pool, ownerId: 'o', token: SECRET, diag: () => {} },
    })
    // The github wiring failed, but the RAG path is untouched; release is a safe no-op.
    expect(reg.specs().map(s => s.name)).toEqual(['retrieve_knowledge'])
    expect(() => release()).not.toThrow()
  })

  it('zero surviving github tools (empty intersection) ⇒ RAG-only, not an empty registry', async () => {
    const t = new FakeTransport({ advertise: [WRITE_TOOL] })
    const { pool } = poolWith(t)
    const { registry: reg, release } = await buildAdvisoryToolsWithGithub(new Set(['retrieve_knowledge']), {
      knowledge: knowledgePort(),
      sessionId: 's1',
      githubMcp: { pool, ownerId: 'o', token: SECRET, diag: () => {} },
    })
    expect(reg.specs().map(s => s.name)).toEqual(['retrieve_knowledge'])
    expect(() => release()).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScribeAgent — github_ tools surface ALONGSIDE retrieve_knowledge in the live run,
// the prompt gains the github hint ONLY when a github_ tool registers, and the
// run never crashes when the connection is degraded.
// ─────────────────────────────────────────────────────────────────────────────
const SPEC_JSON = JSON.stringify({ kind: 'spec', title: 'Todo', body: '# Todo\n\n## Problem\nx' })

/** A provider that, on its FIRST turn, calls `toolName` once (so the registry must hold it),
 *  then on the next turn returns a parseable spec. Captures the system prompt of the LAST call. */
function toolThenSpecProvider(toolName: string): { provider: LlmProvider; lastSystem: () => string | undefined } {
  let turn = 0
  let lastSystem: string | undefined
  const provider: LlmProvider = {
    name: 'fake', model: 'fake',
    async chat(req): Promise<ChatResult> {
      lastSystem = req.system
      turn++
      if (turn === 1) return { toolCalls: [{ name: toolName, args: { path: 'README.md' }, id: 'c1' }] }
      return { text: SPEC_JSON }
    },
  }
  return { provider, lastSystem: () => lastSystem }
}

function collect(bus: EventBus, sessionId: string): AkisEvent[] {
  const seen: AkisEvent[] = []
  bus.subscribe(sessionId, e => seen.push(e))
  return seen
}

describe('ScribeAgent github-mcp integration (RAG-on tool loop)', () => {
  it('PIN 3: surfaces a github_ tool ALONGSIDE retrieve_knowledge and narrates its use on the bus', async () => {
    const bus = new EventBus()
    const seen = collect(bus, 's1')
    const { provider, lastSystem } = toolThenSpecProvider('github_get_file_contents')
    const t = new FakeTransport({ advertise: [READ_TOOL], callResult: () => ({ text: 'FILE', isError: false }) })
    const { pool } = poolWith(t)

    const scribe = new ScribeAgent({ bus, provider, ragEnabled: true, knowledge: knowledgePort() })
    const out = await scribe.run({
      sessionId: 's1', laneId: 'main', idea: 'a todo app',
      githubMcp: { pool, ownerId: 'o', token: SECRET },
    })

    expect(out.type).toBe('spec')
    // The github tool was actually dispatched through the registry, hitting the live transport.
    expect(t.callLog.map(c => c.name)).toEqual(['get_file_contents'])
    // Its use was narrated on the live stream under the github_ display name (ephemeral frame).
    const ghCall = seen.find(e => e.kind === 'tool_call' && (e as { tool?: string }).tool === 'github_get_file_contents')
    expect(ghCall).toBeDefined()
    // The github HINT is appended to the system prompt ONLY because a github_ tool registered.
    expect(lastSystem()).toMatch(/github_\* tools/i)
    expect(lastSystem()).toMatch(/untrusted reference/i)
    // The decrypted token never appears in any emitted event (secrets never on the wire/bus).
    expect(JSON.stringify(seen)).not.toContain(SECRET)
  })

  it('PIN 1: no githubMcp ⇒ Scribe runs the byte-identical RAG-on path (no github hint, no crash)', async () => {
    const bus = new EventBus()
    const { provider, lastSystem } = toolThenSpecProvider('retrieve_knowledge')
    const scribe = new ScribeAgent({ bus, provider, ragEnabled: true, knowledge: knowledgePort() })

    const out = await scribe.run({ sessionId: 's1', laneId: 'main', idea: 'a todo app' })

    expect(out.type).toBe('spec')
    // The RAG hint is present; the github hint is NOT (no github tool ⇒ prompt unchanged).
    expect(lastSystem()).toMatch(/retrieve_knowledge/i)
    expect(lastSystem()).not.toMatch(/github_\* tools/i)
  })

  it('PIN 4: a degraded (McpUnavailable) connection ⇒ Scribe still produces a spec, no github hint, no crash', async () => {
    const bus = new EventBus()
    const { provider, lastSystem } = toolThenSpecProvider('retrieve_knowledge')
    const t = new FakeTransport({ onInit: () => { throw new McpUnavailableError('docker missing') } })
    const { pool } = poolWith(t)

    const scribe = new ScribeAgent({ bus, provider, ragEnabled: true, knowledge: knowledgePort() })
    const out = await scribe.run({
      sessionId: 's1', laneId: 'main', idea: 'a todo app',
      githubMcp: { pool, ownerId: 'o', token: SECRET },
    })

    expect(out.type).toBe('spec')
    // Degraded to today's RAG-on prompt: github hint absent.
    expect(lastSystem()).not.toMatch(/github_\* tools/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// readOnlyAllowlist — the structural GATE-SAFETY guarantee the bridge leans on.
// ─────────────────────────────────────────────────────────────────────────────
describe('readOnlyAllowlist (gate-safety invariant)', () => {
  it('contains NO write/mutation tool name (structural, not conditional)', () => {
    const writeNames = [
      'push_files', 'create_or_update_file', 'create_pull_request', 'merge_pull_request',
      'create_branch', 'fork_repository', 'update_issue', 'create_issue', 'update_pull_request_branch',
    ]
    for (const w of writeNames) expect(GITHUB_READONLY_TOOLS.has(w)).toBe(false)
  })
})
