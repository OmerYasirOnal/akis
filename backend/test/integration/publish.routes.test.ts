import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { registerPublishRoutes } from '../../src/api/publish.routes.js'
import { PublishProfileMemoryStore, type PublishProfileStore } from '../../src/keys/PublishProfileStore.js'

// A fake but well-FORMED key: a multi-line base64 body (the only shape looksLikePem + ssh accept).
// Not a real secret — just valid-looking so the save validator passes and the round-trip asserts hold.
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACDFAKEROUTETESTKEYbm90YXJlYWxrZXl4eHh4eHh4eHh4eHg9PQ==\n-----END OPENSSH PRIVATE KEY-----'
const GOOD = { host: 'oci.example.com', sshUser: 'ubuntu', sshPrivateKey: KEY, targetDir: '/home/ubuntu/app', appPort: 8080, publicUrl: 'http://oci.example.com:8080' }

interface AppOpts {
  profiles?: PublishProfileStore
  userId?: string | undefined
}
function app(opts: AppOpts = {}): { f: FastifyInstance; profiles: PublishProfileStore } {
  const profiles = opts.profiles ?? new PublishProfileMemoryStore()
  const f = Fastify({ logger: false })
  const userIdOf = async (_req: FastifyRequest): Promise<string | undefined> => opts.userId
  registerPublishRoutes(f, { profiles, userIdOf })
  return { f, profiles }
}

let live: FastifyInstance | undefined
afterEach(async () => { await live?.close(); live = undefined })

describe('publish profile routes', () => {
  it('401 on all routes when unauthenticated', async () => {
    const { f } = app({ userId: undefined }); live = f
    expect((await f.inject({ method: 'GET', url: '/publish/profile' })).statusCode).toBe(401)
    expect((await f.inject({ method: 'PUT', url: '/publish/profile', payload: GOOD })).statusCode).toBe(401)
    expect((await f.inject({ method: 'DELETE', url: '/publish/profile' })).statusCode).toBe(401)
  })

  it('PUT refuses EncryptionNotConfigured (409) when the store cannot store', async () => {
    const profiles = { ...new PublishProfileMemoryStore(), canStore: () => false } as PublishProfileStore
    const { f } = app({ userId: 'u1', profiles }); live = f
    const res = await f.inject({ method: 'PUT', url: '/publish/profile', payload: GOOD })
    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('EncryptionNotConfigured')
  })

  it('PUT rejects each malformed field with 400 (option-injection / metachars / .. / bad port/url/key)', async () => {
    const { f } = app({ userId: 'u1' }); live = f
    const bad = (over: Record<string, unknown>) => f.inject({ method: 'PUT', url: '/publish/profile', payload: { ...GOOD, ...over } })
    expect((await bad({ host: '-oProxyCommand=touch /tmp/pwned' })).statusCode).toBe(400) // RCE vector
    expect((await bad({ host: 'host;rm -rf ~' })).statusCode).toBe(400)
    expect((await bad({ sshUser: '-lroot' })).statusCode).toBe(400)
    expect((await bad({ sshUser: 'root;id' })).statusCode).toBe(400)
    expect((await bad({ targetDir: '/home/$(id)' })).statusCode).toBe(400)
    expect((await bad({ targetDir: '/home/`whoami`' })).statusCode).toBe(400)
    expect((await bad({ targetDir: '/home/../etc' })).statusCode).toBe(400)
    expect((await bad({ targetDir: '/home/app\nrm -rf' })).statusCode).toBe(400)
    expect((await bad({ appPort: 80 })).statusCode).toBe(400)
    expect((await bad({ appPort: 0 })).statusCode).toBe(400)
    expect((await bad({ publicUrl: 'javascript:alert(1)' })).statusCode).toBe(400)
    expect((await bad({ sshPrivateKey: 'not a pem' })).statusCode).toBe(400)
  })

  it('PUT rejects an internal/loopback/metadata host or publicUrl with 400 (SSRF guard)', async () => {
    // These pass the OLD shape-only validators (valid hostname/IP, valid http URL) — the route
    // accepted them before the SSRF blocklist. Pinning 400 here would FAIL on the pre-fix code.
    const { f } = app({ userId: 'u1' }); live = f
    const bad = (over: Record<string, unknown>) => f.inject({ method: 'PUT', url: '/publish/profile', payload: { ...GOOD, ...over } })
    expect((await bad({ host: '169.254.169.254' })).statusCode).toBe(400) // cloud metadata
    expect((await bad({ host: '127.0.0.1' })).statusCode).toBe(400)
    expect((await bad({ host: 'localhost' })).statusCode).toBe(400)
    expect((await bad({ host: '10.0.0.5' })).statusCode).toBe(400) // RFC1918
    expect((await bad({ host: '192.168.1.10' })).statusCode).toBe(400)
    expect((await bad({ host: 'metadata.google.internal' })).statusCode).toBe(400)
    expect((await bad({ publicUrl: 'http://169.254.169.254/latest/meta-data/' })).statusCode).toBe(400)
    expect((await bad({ publicUrl: 'http://127.0.0.1:9200/_cat/indices' })).statusCode).toBe(400)
  })

  it('PUT then GET round-trips the status — NEVER the key', async () => {
    const { f, profiles } = app({ userId: 'u1' }); live = f
    const put = await f.inject({ method: 'PUT', url: '/publish/profile', payload: GOOD })
    expect(put.statusCode).toBe(200)
    expect(put.json().present).toBe(true)
    expect(JSON.stringify(put.json())).not.toContain('PRIVATE KEY')
    expect(JSON.stringify(put.json())).not.toContain('FAKE_ROUTE_TEST_KEY_SECRET')

    const get = await f.inject({ method: 'GET', url: '/publish/profile' })
    const body = get.json()
    expect(body.present).toBe(true)
    expect(body.configured).toBe(true)
    expect(body.host).toBe('oci.example.com')
    expect(body.keyFingerprint).toBeTruthy()
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
    // The key IS stored (just never returned).
    expect(profiles.getProfile('u1')?.sshPrivateKey).toBe(KEY)
  })

  it('GET reports present:false before any profile is stored', async () => {
    const { f } = app({ userId: 'u1' }); live = f
    const body = (await f.inject({ method: 'GET', url: '/publish/profile' })).json()
    expect(body.present).toBe(false)
    expect(body.configured).toBe(true)
  })

  it('DELETE then GET → present:false (no stale decryptable row)', async () => {
    const { f } = app({ userId: 'u1' }); live = f
    await f.inject({ method: 'PUT', url: '/publish/profile', payload: GOOD })
    expect((await f.inject({ method: 'DELETE', url: '/publish/profile' })).json().removed).toBe(true)
    expect((await f.inject({ method: 'GET', url: '/publish/profile' })).json().present).toBe(false)
  })

  it('cross-user isolation: uid B cannot read uid A profile', async () => {
    const profiles = new PublishProfileMemoryStore()
    const asA = app({ userId: 'A', profiles }); live = asA.f
    await asA.f.inject({ method: 'PUT', url: '/publish/profile', payload: GOOD })
    const asB = app({ userId: 'B', profiles })
    try {
      const body = (await asB.f.inject({ method: 'GET', url: '/publish/profile' })).json()
      expect(body.present).toBe(false) // B has no profile of their own
    } finally {
      await asB.f.close()
    }
  })

  it('accepts a profile WITHOUT the optional appPort/publicUrl', async () => {
    const { f } = app({ userId: 'u1' }); live = f
    const res = await f.inject({ method: 'PUT', url: '/publish/profile', payload: { host: 'h.example.com', sshUser: 'opc', sshPrivateKey: KEY, targetDir: '/home/opc/app' } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.present).toBe(true)
    expect('appPort' in body).toBe(false)
  })
})
