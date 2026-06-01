import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { IngestQueue } from '../../src/knowledge/ingest/IngestQueue.js'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { EventBus } from '../../src/events/bus.js'

const noBackoff = { backoffMs: () => 0 }
const fixedNow = () => '2026-06-01T00:00:00Z'

describe('IngestQueue (F1-AC7: async, bounded failure, never silently dropped)', () => {
  it('runs a task and counts success', async () => {
    const q = new IngestQueue(noBackoff)
    let ran = 0
    q.enqueue({}, async () => { ran++ })
    await q.drain()
    expect(ran).toBe(1)
    expect(q.metrics.ingested).toBe(1)
  })
  it('retries then succeeds', async () => {
    const q = new IngestQueue(noBackoff)
    let n = 0
    q.enqueue({}, async () => { n++; if (n < 3) throw new Error('transient') })
    await q.drain()
    expect(n).toBe(3)
    expect(q.metrics.ingested).toBe(1)
    expect(q.deadLetters).toHaveLength(0)
  })
  it('dead-letters after exhausting retries (never dropped)', async () => {
    const q = new IngestQueue(noBackoff)
    q.enqueue({ what: 'x' }, async () => { throw new Error('always') })
    await q.drain()
    expect(q.metrics.ingested).toBe(0)
    expect(q.metrics.deadLettered).toBe(1)
    expect(q.deadLetters[0]?.error).toContain('always')
  })
})

describe('RagService ingest/retrieve', () => {
  it('round-trips: ingested content is retrievable; re-ingest dedups (F1-AC3)', async () => {
    const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
    const input = { text: 'postgres database migrations and schema design', source: 'conversation', sourceId: 's1', userId: 'u1', sessionId: 's1' }
    service.ingest(input)
    await queue.drain()
    service.ingest(input) // identical -> dedup
    await queue.drain()
    expect(queue.metrics.dedupHits).toBeGreaterThanOrEqual(1)
    const res = await service.retrieve('database schema in postgres', { userId: 'u1' }, 5)
    expect(res.length).toBeGreaterThan(0)
    expect(res[0]?.text).toContain('postgres')
  })

  it('tenancy isolation: user B never retrieves user A’s chunk (F1-AC5)', async () => {
    const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
    service.ingest({ text: 'user A confidential roadmap notes', source: 'conversation', sourceId: 'sa', userId: 'A', sessionId: 'sa' })
    await queue.drain()
    expect(await service.retrieve('roadmap', { userId: 'B' }, 5)).toHaveLength(0)
    expect((await service.retrieve('roadmap', { userId: 'A' }, 5)).length).toBeGreaterThan(0)
  })

  it('excludes secret content before embedding (F1-AC12)', async () => {
    const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
    service.ingest({ text: 'token sk-ant-abcdefghijklmnop1234567890', source: 'conversation', sourceId: 's1', userId: 'u1', sessionId: 's1' })
    await queue.drain()
    expect(queue.metrics.excluded).toBe(1)
    expect(await service.retrieve('token', { userId: 'u1' }, 5)).toHaveLength(0)
  })

  it('right-to-forget: deleteBySession removes chunks idempotently (F1-AC13)', async () => {
    const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
    service.ingest({ text: 'forgettable content here', source: 'conversation', sourceId: 's1', userId: 'u1', sessionId: 's1' })
    await queue.drain()
    expect(service.deleteBySession('s1')).toBeGreaterThan(0)
    expect(service.deleteBySession('s1')).toBe(0) // idempotent
    expect(await service.retrieve('forgettable', { userId: 'u1' }, 5)).toHaveLength(0)
  })
})

const CORPUS: Array<{ id: string; text: string }> = [
  { id: 'auth', text: 'user authentication login logout sessions and password hashing with bcrypt' },
  { id: 'payments', text: 'stripe payments billing invoices subscriptions and checkout flow' },
  { id: 'db', text: 'postgres database migrations schema indexes and query optimization' },
  { id: 'cache', text: 'redis caching layer ttl eviction and rate limiting buckets' },
  { id: 'search', text: 'full text search bm25 ranking inverted index and tokenization' },
  { id: 'email', text: 'transactional email smtp templates bounce handling and deliverability' },
  { id: 'upload', text: 'file upload storage s3 buckets presigned urls and virus scanning' },
  { id: 'realtime', text: 'websocket realtime notifications server sent events and presence' },
  { id: 'analytics', text: 'analytics dashboards charts metrics funnels and retention cohorts' },
  { id: 'i18n', text: 'internationalization localization translations locales and pluralization' },
  { id: 'testing', text: 'unit tests integration tests mocking fixtures and coverage reports' },
  { id: 'deploy', text: 'deployment docker containers kubernetes rollout and blue green releases' },
]
const QUERIES: Array<{ q: string; expect: string }> = [
  { q: 'how do users log in with passwords', expect: 'auth' },
  { q: 'bcrypt password hashing for login', expect: 'auth' },
  { q: 'stripe subscription billing', expect: 'payments' },
  { q: 'checkout and invoices', expect: 'payments' },
  { q: 'postgres schema migrations', expect: 'db' },
  { q: 'database index query optimization', expect: 'db' },
  { q: 'redis cache eviction ttl', expect: 'cache' },
  { q: 'rate limiting buckets', expect: 'cache' },
  { q: 'bm25 ranking inverted index', expect: 'search' },
  { q: 'full text tokenization', expect: 'search' },
  { q: 'smtp email templates', expect: 'email' },
  { q: 'email bounce deliverability', expect: 'email' },
  { q: 's3 presigned upload urls', expect: 'upload' },
  { q: 'file storage virus scanning', expect: 'upload' },
  { q: 'websocket realtime presence', expect: 'realtime' },
  { q: 'server sent events notifications', expect: 'realtime' },
  { q: 'analytics retention cohorts', expect: 'analytics' },
  { q: 'dashboards funnels metrics', expect: 'analytics' },
  { q: 'docker kubernetes rollout', expect: 'deploy' },
  { q: 'blue green deployment releases', expect: 'deploy' },
]

describe('Golden eval (F1-AC8: hybrid retrieval top-5 >= 80%)', () => {
  it('places the expected chunk in top-5 for >= 80% of queries', async () => {
    const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
    for (const doc of CORPUS) {
      service.ingest({ text: doc.text, source: 'corpus', sourceId: doc.id, userId: 'u1', sessionId: 'seed' })
    }
    await queue.drain()
    let hits = 0
    for (const { q, expect: want } of QUERIES) {
      const res = await service.retrieve(q, { userId: 'u1' }, 5)
      if (res.some(r => r.source === `corpus:${want}`)) hits++
    }
    const recall = hits / QUERIES.length
    expect(recall).toBeGreaterThanOrEqual(0.8)
  })
})

describe('AC10: no knowledge module imports a gate minter', () => {
  it('no file under src/knowledge references a gate minter/gate module', () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/knowledge')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        if (statSync(p).isDirectory()) { walk(p); continue }
        if (!p.endsWith('.ts')) continue
        const src = readFileSync(p, 'utf8')
        if (/gates\/|specGate|pushGate|mintApproved|createVerifier/.test(src)) offenders.push(p)
      }
    }
    walk(dir)
    expect(offenders).toEqual([])
  })
})
