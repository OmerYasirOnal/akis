import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { registerSessionRoutes, type SessionPublisher } from '../../src/api/sessions.routes.js'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { PublishProfileMemoryStore } from '../../src/keys/PublishProfileStore.js'
import { initialSession, type SessionState, type PublishRecord } from '@akis/shared'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE_PUBLISH_ROUTE_KEY_SECRET\n-----END OPENSSH PRIVATE KEY-----'
const PROFILE_INPUT = { host: 'oci.example.com', sshUser: 'ubuntu', sshPrivateKey: KEY, targetDir: '/home/ubuntu/app' }

let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

/** A `done` session owned by `ownerId`, with produced files, seeded into the store. */
async function seedDone(store: MockSessionStore, id: string, ownerId?: string): Promise<SessionState> {
  const s: SessionState = {
    ...initialSession(id, 'a todo app', ownerId),
    status: 'done',
    code: { files: [{ filePath: 'index.html', content: '<h1>hi</h1>' }] },
  }
  await store.create(s)
  return s
}

interface BuildOpts {
  /** The user the request resolves to. */
  userId?: string | undefined
  /** A publisher to inject; defaults to one returning ok:true. */
  publisher?: SessionPublisher
  /** Seed a profile for this user id (defaults to the requester). */
  profileFor?: string
  /** Omit the publish wiring entirely. */
  noPublishWiring?: boolean
}
async function build(opts: BuildOpts = {}) {
  const store = new MockSessionStore()
  const services = buildServices({ store, skillsDir, provider: new MockProvider() })
  const orchestrator = new Orchestrator(services)
  const profiles = new PublishProfileMemoryStore()
  const calls = { published: 0, lastFiles: undefined as unknown }
  const publisher: SessionPublisher = opts.publisher ?? (async ({ files }) => {
    calls.published++; calls.lastFiles = files
    return { ok: true, url: 'http://oci.example.com:8080', at: '2026-06-05T00:00:00Z', reachable: true, appType: 'static', logTail: ['deployed'] }
  })
  const userIdOf = async (_req: FastifyRequest): Promise<string | undefined> => opts.userId
  const a = Fastify({ logger: false })
  registerSessionRoutes(a, {
    orchestrator, services, userIdOf,
    ...(opts.noPublishWiring ? {} : { publishProfiles: profiles, publisher }),
  })
  return { a, store, profiles, calls }
}

describe('POST /sessions/:id/publish (non-gating, owner-scoped)', () => {
  it('non-done session → 409 WrongStatusError', async () => {
    const { a, store, profiles } = await build({ userId: 'u1' }); app = a
    profiles.set('u1', PROFILE_INPUT)
    await store.create({ ...initialSession('s1', 'idea', 'u1'), status: 'building' })
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('WrongStatusError')
  })

  it('non-owner (uid B on uid A done session) → 404 BEFORE any NoPublishProfile leak', async () => {
    const { a, store, profiles } = await build({ userId: 'B' }); app = a
    profiles.set('A', PROFILE_INPUT) // A has a profile; B does not
    await seedDone(store, 's1', 'A')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    // 404 (not 409): a non-owner cannot even confirm the session exists, let alone probe profiles.
    expect(res.statusCode).toBe(404)
  })

  it('no usable profile → 409 NoPublishProfile', async () => {
    const { a, store } = await build({ userId: 'u1' }); app = a // no profile seeded
    await seedDone(store, 's1', 'u1')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('NoPublishProfileError')
  })

  it('happy path: persists the publish record + LEAVES status done', async () => {
    const { a, store, profiles, calls } = await build({ userId: 'u1' }); app = a
    profiles.set('u1', PROFILE_INPUT)
    await seedDone(store, 's1', 'u1')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.statusCode).toBe(200)
    expect(calls.published).toBe(1)
    const body = res.json() as SessionState
    expect(body.status).toBe('done') // NEVER moved
    expect(body.publish?.ok).toBe(true)
    expect(body.publish?.url).toBe('http://oci.example.com:8080')
    // Durably persisted on the generic patch path.
    expect((await store.get('s1'))?.publish?.ok).toBe(true)
  })

  it('a deploy FAILURE persists ok:false and KEEPS status done (non-gating proof)', async () => {
    const failing: SessionPublisher = async () => ({ ok: false, at: '2026-06-05T00:00:00Z', appType: 'node-service', logTail: ['node not found on the instance'] })
    const { a, store, profiles } = await build({ userId: 'u1', publisher: failing }); app = a
    profiles.set('u1', PROFILE_INPUT)
    await seedDone(store, 's1', 'u1')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.statusCode).toBe(200) // honest report, NOT a 500
    const body = res.json() as SessionState
    expect(body.status).toBe('done') // status STAYS done — publish is non-gating
    expect(body.publish?.ok).toBe(false)
    expect(body.publish?.logTail.join(' ')).toContain('node not found')
  })

  it('a publisher that takes "too long" still returns (the publisher owns its own deadline)', async () => {
    // The route does not itself time out — the publisher returns an ok:false deadline record. We
    // simulate that contract: a slow-but-bounded publisher returns ok:false and the route responds.
    const slow: SessionPublisher = async () => {
      await new Promise(r => setTimeout(r, 5))
      return { ok: false, at: '2026-06-05T00:00:00Z', appType: 'static', logTail: ['exceeded the total deadline'] }
    }
    const { a, store, profiles } = await build({ userId: 'u1', publisher: slow }); app = a
    profiles.set('u1', PROFILE_INPUT)
    await seedDone(store, 's1', 'u1')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as SessionState).publish?.ok).toBe(false)
  })

  it('the response/record carry NO key substring', async () => {
    const { a, store, profiles } = await build({ userId: 'u1' }); app = a
    profiles.set('u1', PROFILE_INPUT)
    await seedDone(store, 's1', 'u1')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.body).not.toContain('FAKE_PUBLISH_ROUTE_KEY_SECRET')
    expect(res.body).not.toContain('PRIVATE KEY')
  })

  it('unknown session → 404', async () => {
    const { a, profiles } = await build({ userId: 'u1' }); app = a
    profiles.set('u1', PROFILE_INPUT)
    expect((await a.inject({ method: 'POST', url: '/sessions/nope/publish' })).statusCode).toBe(404)
  })

  it('publish not wired on the server → 409 (graceful, not a 500)', async () => {
    const { a, store } = await build({ userId: 'u1', noPublishWiring: true }); app = a
    await seedDone(store, 's1', 'u1')
    const res = await a.inject({ method: 'POST', url: '/sessions/s1/publish' })
    expect(res.statusCode).toBe(409)
  })
})

// Keep the PublishRecord type referenced so an unused-import lint never strips it.
const _typecheck: PublishRecord = { ok: true, at: 'x', appType: 'static', logTail: [] }
void _typecheck
