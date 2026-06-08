/**
 * CONTRACT: the external-write (Jira/Confluence via MCP) HTTP endpoints. Gate-safe: PROPOSE records
 * intent; CONFIRM is the ONLY path that executes, and only of the exact digest-confirmed, allow-listed
 * content, through the human's per-provider MCP transport. Owner-scoped.
 */
import { describe, it, expect } from 'vitest'
import { type SessionState, EXTERNAL_WRITES_MAX } from '@akis/shared'
import Fastify from 'fastify'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerSessionRoutes } from '../../src/api/sessions.routes.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import type { SessionStore } from '../../src/store/SessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { MemoryRemoteMcpAuthStore } from '../../src/agent/mcp/StoreBackedOAuthProvider.js'
import type { McpTransport } from '../../src/agent/mcp/McpTransport.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function makeApp(opts: { owner?: string; connected?: boolean; slowMs?: number } = {}) {
  const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
  const calls: Array<{ name: string; args: unknown }> = []
  const fakeTransport: McpTransport = {
    initialize: async () => {}, listTools: async () => [],
    callTool: async (name, args) => {
      calls.push({ name, args })
      if (opts.slowMs) await new Promise(r => setTimeout(r, opts.slowMs)) // hold the write in-flight (concurrency tests)
      return { text: 'created: https://org.atlassian.net/wiki/PAGE-1', isError: false }
    },
    close: async () => {},
  }
  // Mutable identity so one store can be reached as different users (owner-scope tests).
  let currentUser: string | undefined = opts.owner ?? 'owner1'
  const f = Fastify({ logger: false })
  registerSessionRoutes(f, {
    orchestrator: new Orchestrator(services), services,
    userIdOf: async () => currentUser,
    mcpAuthStore: new MemoryRemoteMcpAuthStore(),
    mcpTransportFor: () => (opts.connected === false ? undefined : fakeTransport),
  })
  return { f, services, calls, setUser: (u: string | undefined) => { currentUser = u } }
}

async function newSession(f: ReturnType<typeof makeApp>['f']): Promise<string> {
  const res = await f.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app' } })
  return res.json().id as string
}

const PROPOSAL = { provider: 'atlassian', action: 'createPage', summary: 'Create Confluence page "Docs"', target: { spaceKey: 'ENG' }, payload: { title: 'Docs', body: '# Hello' } }

describe('CONTRACT: external-write routes (propose → human-confirm → execute)', () => {
  it('PROPOSE records the proposal + returns a digest; LIST shows it as proposed (no execution)', async () => {
    const { f, calls } = makeApp()
    const id = await newSession(f)
    const prop = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })
    expect(prop.statusCode).toBe(200)
    expect(prop.json().digest).toMatch(/^[0-9a-f]{64}$/)
    const list = await f.inject({ method: 'GET', url: `/sessions/${id}/external-writes` })
    expect(list.json().writes).toHaveLength(1)
    expect(list.json().writes[0]).toMatchObject({ status: 'proposed', action: 'createPage' })
    // LIST carries the EXACT bound bytes + the SAME content digest the propose returned, so a confirm
    // UI can render what the digest binds and confirm with the digest (Phase D) — no re-propose.
    expect(list.json().writes[0].target).toEqual(PROPOSAL.target)
    expect(list.json().writes[0].payload).toEqual(PROPOSAL.payload)
    expect(list.json().writes[0].digest).toBe(prop.json().digest)
    expect(calls).toHaveLength(0) // proposing executes NOTHING
  })

  it('PROPOSE rejects an action not on the write allow-list (400)', async () => {
    const { f } = makeApp()
    const id = await newSession(f)
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { ...PROPOSAL, action: 'deletePage' } })
    expect(res.statusCode).toBe(400)
  })

  it('PROVIDER-AWARE: a GitHub action is accepted under provider github but REJECTED under atlassian', async () => {
    const { f } = makeApp()
    const id = await newSession(f)
    // github action under github → 200 (on the github allow-list)
    const ok = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { provider: 'github', action: 'issue_write', summary: 'Open issue', target: { owner: 'OmerYasirOnal', repo: 'akis' }, payload: { method: 'create', title: 'Bug' } } })
    expect(ok.statusCode).toBe(200)
    // SAME github action under atlassian → 400 (off that provider's set — no cross-provider smuggle)
    const bad = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { provider: 'atlassian', action: 'issue_write', summary: 'x', target: {}, payload: {} } })
    expect(bad.statusCode).toBe(400)
    // and an atlassian action under github → 400 (vice-versa)
    const bad2 = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { provider: 'github', action: 'createPage', summary: 'x', target: {}, payload: {} } })
    expect(bad2.statusCode).toBe(400)
  })

  it('SHARED RECORDER: a github PROPOSE dedupes on content (route + agent tool share one impl) — same writeId, ONE record', async () => {
    const { f } = makeApp()
    const id = await newSession(f)
    const body = { provider: 'github', action: 'add_issue_comment', summary: 'Comment on #42', target: { owner: 'OmerYasirOnal', repo: 'akis', issue_number: 42 }, payload: { body: 'verified — 7 real tests passed' } }
    const a = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: body })).json()
    const b = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { ...body, summary: 'a DIFFERENT summary (not part of the digest)' } })).json()
    expect(b.id).toBe(a.id) // same content ⇒ the recorder returned the existing proposal
    const list = await f.inject({ method: 'GET', url: `/sessions/${id}/external-writes` })
    expect(list.json().writes).toHaveLength(1) // ONE card per content
  })

  it('SHARED RECORDER: a github PROPOSE rejects a colliding target/payload (400, nothing recorded)', async () => {
    const { f } = makeApp()
    const id = await newSession(f)
    // `body` in BOTH target and payload — the recorder's disjoint-key pre-check refuses it.
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { provider: 'github', action: 'add_issue_comment', summary: 'x', target: { owner: 'o', repo: 'r', body: 'in-target' }, payload: { body: 'in-payload' } } })
    expect(res.statusCode).toBe(400)
    const list = await f.inject({ method: 'GET', url: `/sessions/${id}/external-writes` })
    expect(list.json().writes).toHaveLength(0)
  })

  it('PROVIDER-AWARE: a GitHub write CONFIRMS + EXECUTES through the github transport (merged target+payload)', async () => {
    const { f, calls } = makeApp({ connected: true })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { provider: 'github', action: 'issue_write', summary: 'Open issue "Bug"', target: { owner: 'OmerYasirOnal', repo: 'akis' }, payload: { method: 'create', title: 'Bug', body: 'repro' } } })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, status: 'executed' })
    expect(calls).toEqual([{ name: 'issue_write', args: { owner: 'OmerYasirOnal', repo: 'akis', method: 'create', title: 'Bug', body: 'repro' } }])
  })

  it('CONFIRM with the matching digest EXECUTES via the transport + marks executed', async () => {
    const { f, calls } = makeApp({ connected: true })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, status: 'executed' })
    expect(calls).toEqual([{ name: 'createPage', args: { spaceKey: 'ENG', title: 'Docs', body: '# Hello' } }]) // merged target+payload
    const list = await f.inject({ method: 'GET', url: `/sessions/${id}/external-writes` })
    expect(list.json().writes[0].status).toBe('executed')
  })

  it('CONFIRM with a WRONG digest does NOT execute (gate refuses → failed, nothing written)', async () => {
    const { f, calls } = makeApp({ connected: true })
    const id = await newSession(f)
    const { id: writeId } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest: 'deadbeef' } })
    expect(res.json().status).toBe('failed')
    expect(calls).toHaveLength(0) // digest mismatch → mint throws → no write
  })

  it('CONFIRM when NOT connected → 409 (no transport, nothing written)', async () => {
    const { f, calls } = makeApp({ connected: false })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.statusCode).toBe(409)
    expect(calls).toHaveLength(0)
  })

  it('a second CONFIRM on an already-resolved proposal → 409', async () => {
    const { f } = makeApp({ connected: true })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    const again = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(again.statusCode).toBe(409)
  })

  it('two CONCURRENT confirms execute the external write ONCE (in-flight guard — no double page/issue)', async () => {
    // Both requests read status:'proposed' before either persists; without the per-writeId
    // in-flight guard BOTH would reach the transport and create a duplicate page/issue
    // (gate-keeper HIGH, 2026-06-07). The slow transport holds the first confirm in-flight
    // while the second arrives.
    const { f, calls } = makeApp({ connected: true, slowMs: 150 })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const [a, b] = await Promise.all([
      f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } }),
      f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } }),
    ])
    const codes = [a.statusCode, b.statusCode].sort()
    expect(codes).toEqual([200, 409]) // one wins, one is refused
    const refused = a.statusCode === 409 ? a : b
    // Either guard may win the race: the synchronous in-flight Set (ConfirmInProgress) or the durable
    // 'proposed'→'executing' transition (AlreadyResolved). Both mean "refused, single execute".
    expect(['ConfirmInProgress', 'AlreadyResolved']).toContain(refused.json().code)
    expect(calls).toHaveLength(1) // the EXTERNAL side effect fired exactly once
  })

  it('OWNER-SCOPED: a NON-owner cannot list/propose/confirm another user\'s external writes (404, nothing executed)', async () => {
    const { f, calls, setUser } = makeApp({ connected: true })
    const id = await newSession(f) // created as owner1
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    setUser('intruder') // a different authenticated user
    const list = await f.inject({ method: 'GET', url: `/sessions/${id}/external-writes` })
    const propose = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })
    const confirm = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect([list.statusCode, propose.statusCode, confirm.statusCode]).toEqual([404, 404, 404]) // existence not even confirmed
    expect(calls).toHaveLength(0) // no outward write fired on the intruder's behalf
  })

  it('Bug 2: a concurrent version bump during an ATLASSIAN propose is RETRIED (not a 500) — the proposal lands', async () => {
    // The atlassian propose used to append with a BARE store.update (no retry): a concurrent version
    // bump threw → Fastify default 500 → the proposal silently lost. It now shares the github recorder's
    // retry-on-conflict appender. A store whose FIRST update on this session throws ONE version conflict
    // (then succeeds) exercises that path: the route must reply 200 and record the proposal.
    const inner = new MockSessionStore()
    let conflicted = false
    const flaky: SessionStore = {
      create: (s) => inner.create(s),
      get: (id) => inner.get(id),
      async update(id, patch, expectedVersion) {
        // Inject exactly one version conflict on the FIRST propose append (an externalWrites patch).
        if (!conflicted && patch.externalWrites) {
          conflicted = true
          await inner.update(id, {}, expectedVersion)                     // a concurrent writer wins first
          throw new Error(`version conflict: ${expectedVersion + 1} !== ${expectedVersion}`)
        }
        return inner.update(id, patch, expectedVersion)
      },
      recordApproval: (...a) => inner.recordApproval(...a),
      recordVerification: (...a) => inner.recordVerification(...a),
      listByOwner: (o) => inner.listByOwner(o),
      listSummariesByOwner: (o) => inner.listSummariesByOwner(o),
    }
    const services = buildServices({ store: flaky, skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const f = Fastify({ logger: false })
    registerSessionRoutes(f, { orchestrator: new Orchestrator(services), services, userIdOf: async () => 'owner1', mcpAuthStore: new MemoryRemoteMcpAuthStore() })
    const id = await newSession(f)
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })
    expect(res.statusCode).toBe(200)                                       // NOT a 500 — the conflict was absorbed
    expect(conflicted).toBe(true)                                          // the conflict path was actually hit
    const list = await f.inject({ method: 'GET', url: `/sessions/${id}/external-writes` })
    expect(list.json().writes).toHaveLength(1)                            // the proposal landed despite the conflict
  })

  it('Bug 1/3: a confirm of an OLD in-flight record still works after the cap fills with newer proposals (it is never evicted)', async () => {
    // Propose ONE atlassian write (status 'proposed'), then fill the row to the cap with DISTINCT
    // proposals — but make the OLDEST record (besides our target) terminal so the appender has
    // something safe to evict. The STATUS-AWARE appender drops only terminal records, so the original
    // in-flight 'proposed' record SURVIVES every later propose; a confirm of it still finds it and
    // EXECUTES (the status-blind slice evicted index 0 → confirm 404, no outcome recorded — bug 1/3).
    const { f, calls, services } = makeApp({ connected: true })
    const id = await newSession(f)
    const target = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()

    // Seed the store directly up to EXACTLY the cap: our target ('proposed', oldest) + one terminal
    // record + (cap-2) more proposed records. Each later route-propose will evict the terminal one,
    // never our target.
    const cur = (await services.store.get(id))!
    const filler: NonNullable<SessionState['externalWrites']> = [
      cur.externalWrites![0]!, // our target proposal stays at index 0
      { id: 'term', provider: 'atlassian', action: 'createPage', summary: 't', target: { spaceKey: 'Z' }, payload: { title: 'T', body: 'b' }, status: 'executed', proposedAt: '2026-06-08T00:00:00.000Z', confirmedAt: '2026-06-08T00:00:01.000Z', result: 'done' },
    ]
    for (let i = 0; i < EXTERNAL_WRITES_MAX - 2; i++) {
      filler.push({ id: `f${i}`, provider: 'atlassian', action: 'createPage', summary: `f${i}`, target: { spaceKey: `S${i}` }, payload: { title: `T${i}`, body: `b${i}` }, status: 'proposed', proposedAt: '2026-06-08T00:00:00.000Z' })
    }
    await services.store.update(id, { externalWrites: filler }, cur.version)
    expect((await services.store.get(id))!.externalWrites).toHaveLength(EXTERNAL_WRITES_MAX)

    // A NEW distinct proposal — the row is at cap, so the appender must drop the OLDEST TERMINAL record
    // ('term'), NOT our in-flight target.
    const more = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { ...PROPOSAL, payload: { title: 'New', body: 'distinct' } } })
    expect(more.statusCode).toBe(200)
    const afterIds = (await services.store.get(id))!.externalWrites!.map(w => w.id)
    expect(afterIds).toContain(target.id)   // our in-flight record SURVIVED
    expect(afterIds).not.toContain('term')  // the terminal record was evicted to make room

    // The confirm of the ORIGINAL still-'proposed' record finds it and executes (no eviction-404).
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${target.id}/confirm`, payload: { digest: target.digest } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, status: 'executed' })
    expect(calls).toHaveLength(1) // the outward write fired exactly once, for the surviving record
  })

  it('Bug 1: a propose into a row FULL of non-terminal records is refused with 409 TooManyPending (no in-flight record evicted)', async () => {
    const { f, services } = makeApp()
    const id = await newSession(f)
    const cur = (await services.store.get(id))!
    const full: NonNullable<SessionState['externalWrites']> = Array.from({ length: EXTERNAL_WRITES_MAX }, (_, i) => ({
      id: `p${i}`, provider: 'atlassian', action: 'createPage', summary: `p${i}`,
      target: { spaceKey: `S${i}` }, payload: { title: `T${i}`, body: `b${i}` },
      status: 'proposed' as const, proposedAt: '2026-06-08T00:00:00.000Z',
    }))
    await services.store.update(id, { externalWrites: full }, cur.version)
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { ...PROPOSAL, payload: { title: 'Z', body: 'z' } } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('TooManyPending')
    // The full row of in-flight proposals is untouched — nothing evicted, nothing appended.
    expect((await services.store.get(id))!.externalWrites).toHaveLength(EXTERNAL_WRITES_MAX)
  })

  it('IN-DOUBT guard (#30): the record is durably executing BEFORE the outward call → a retry never re-executes', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const ref = { id: '' }
    let statusAtCall: string | undefined
    let calls = 0
    const transport: McpTransport = {
      initialize: async () => {}, listTools: async () => [],
      callTool: async () => { calls++; statusAtCall = (await services.store.get(ref.id))?.externalWrites?.[0]?.status; return { text: 'created: PAGE-1', isError: false } },
      close: async () => {},
    }
    const f = Fastify({ logger: false })
    registerSessionRoutes(f, { orchestrator: new Orchestrator(services), services, userIdOf: async () => 'owner1', mcpAuthStore: new MemoryRemoteMcpAuthStore(), mcpTransportFor: () => transport })
    ref.id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${ref.id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${ref.id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.json().status).toBe('executed')
    expect(statusAtCall).toBe('executing') // the in-doubt mark was DURABLE before the side effect fired
    // a retry on the now-resolved record → 409, NO second outward call (at-most-once)
    const retry = await f.inject({ method: 'POST', url: `/sessions/${ref.id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(retry.statusCode).toBe(409)
    expect(calls).toBe(1)
  })

  // ── FR-19: the confirm executor is gated on AUTH + an MCP backend BEFORE any transport call ──
  // Both pre-conditions sit ABOVE the mint/execute lines (sessions.routes.ts ~382/383). A regression
  // that reorders them below the side effect, or drops either check, would let an unauthenticated
  // caller — or a deployment with no MCP backend wired — fire a real external write. These guards
  // count the transport's calls to prove the outward write NEVER happens on the refused path.
  it('FR-19(a): confirm with NO authenticated user → 401 Unauthorized, ZERO transport calls', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const calls: Array<{ name: string; args: unknown }> = []
    const transport: McpTransport = {
      initialize: async () => {}, listTools: async () => [],
      callTool: async (name, args) => { calls.push({ name, args }); return { text: 'created: PAGE-1', isError: false } },
      close: async () => {},
    }
    const f = Fastify({ logger: false })
    // userIdOf always resolves undefined: the session is created OWNERLESS (so accessibleSession lets
    // the confirm through), then the confirm's own auth check refuses it.
    registerSessionRoutes(f, { orchestrator: new Orchestrator(services), services, userIdOf: async () => undefined, mcpAuthStore: new MemoryRemoteMcpAuthStore(), mcpTransportFor: () => transport })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.statusCode).toBe(401)
    expect(res.json().code).toBe('Unauthorized')
    expect(calls).toHaveLength(0) // the gate fired ABOVE mint/execute — nothing reached the transport
  })

  it('FR-19(b): confirm with NO mcpAuthStore wired → 409 McpUnavailable, ZERO transport calls', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const calls: Array<{ name: string; args: unknown }> = []
    const transport: McpTransport = {
      initialize: async () => {}, listTools: async () => [],
      callTool: async (name, args) => { calls.push({ name, args }); return { text: 'created: PAGE-1', isError: false } },
      close: async () => {},
    }
    const f = Fastify({ logger: false })
    // Authenticated (so the 401 above is satisfied) but mcpAuthStore is OMITTED — the confirm route
    // must refuse with McpUnavailable before constructing any transport, so a mcpTransportFor that
    // WOULD hand back a live transport is never even consulted.
    registerSessionRoutes(f, { orchestrator: new Orchestrator(services), services, userIdOf: async () => 'owner1', mcpTransportFor: () => transport })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('McpUnavailable')
    expect(calls).toHaveLength(0) // refused before any transport was built/called
  })

  // ── NFR-5 (backend half): the PERSISTED outcome string is bounded to ≤500 chars ──
  // The executor slices the transport's result to .slice(0, 500) (sessions.routes.ts ~409). A
  // regression that widens or drops that bound would let an unbounded provider response bloat the
  // stored record (and every list/confirm payload). A transport returning a >500-char body proves
  // the cap holds on the durable record.
  it('NFR-5: a >500-char transport result is truncated to ≤500 chars in the persisted record', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const HUGE = 'x'.repeat(5000) // far beyond the 500-char persisted cap
    const transport: McpTransport = {
      initialize: async () => {}, listTools: async () => [],
      callTool: async () => ({ text: HUGE, isError: false }),
      close: async () => {},
    }
    const f = Fastify({ logger: false })
    registerSessionRoutes(f, { orchestrator: new Orchestrator(services), services, userIdOf: async () => 'owner1', mcpAuthStore: new MemoryRemoteMcpAuthStore(), mcpTransportFor: () => transport })
    const id = await newSession(f)
    const { id: writeId, digest } = (await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: PROPOSAL })).json()
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes/${writeId}/confirm`, payload: { digest } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, status: 'executed' })
    const rec = (await services.store.get(id))!.externalWrites!.find(w => w.id === writeId)!
    expect(rec.status).toBe('executed')
    expect(rec.result).toBeDefined()
    expect(rec.result!.length).toBeLessThanOrEqual(500) // the durable outcome is bounded
  })

  // ── FR-12: a row full of NON-TERMINAL github proposals refuses a new github propose (409 TooManyPending) ──
  // The github branch shares the status-aware appender with atlassian: a full cap (EXTERNAL_WRITES_MAX)
  // of non-terminal records has nothing safe to evict, so a new propose is a clean refusal — NOT a silent
  // eviction of an in-flight proposal. (The atlassian variant is covered above; this pins the GITHUB
  // recorder path, which routes through recordGithubProposal.)
  it('FR-12: a github propose into a row full of non-terminal github proposals → 409 TooManyPending', async () => {
    const { f, services } = makeApp()
    const id = await newSession(f)
    const cur = (await services.store.get(id))!
    const full: NonNullable<SessionState['externalWrites']> = Array.from({ length: EXTERNAL_WRITES_MAX }, (_, i) => ({
      id: `g${i}`, provider: 'github', action: 'add_issue_comment', summary: `g${i}`,
      target: { owner: 'OmerYasirOnal', repo: 'akis', issue_number: i }, payload: { body: `comment ${i}` },
      status: 'proposed' as const, proposedAt: '2026-06-08T00:00:00.000Z',
    }))
    await services.store.update(id, { externalWrites: full }, cur.version)
    const res = await f.inject({ method: 'POST', url: `/sessions/${id}/external-writes`, payload: { provider: 'github', action: 'add_issue_comment', summary: 'one more', target: { owner: 'OmerYasirOnal', repo: 'akis', issue_number: 999 }, payload: { body: 'the overflow comment' } } })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('TooManyPending')
    // The full row of in-flight proposals is untouched — nothing evicted, nothing appended.
    expect((await services.store.get(id))!.externalWrites).toHaveLength(EXTERNAL_WRITES_MAX)
  })
})
