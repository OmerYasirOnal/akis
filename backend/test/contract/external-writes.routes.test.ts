/**
 * CONTRACT: the external-write (Jira/Confluence via MCP) HTTP endpoints. Gate-safe: PROPOSE records
 * intent; CONFIRM is the ONLY path that executes, and only of the exact digest-confirmed, allow-listed
 * content, through the human's per-provider MCP transport. Owner-scoped.
 */
import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { registerSessionRoutes } from '../../src/api/sessions.routes.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
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
})
