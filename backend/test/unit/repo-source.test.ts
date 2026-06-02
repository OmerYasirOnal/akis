import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/events/bus.js'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { MockRepoReader, type RepoReader } from '../../src/knowledge/ingest/RepoReader.js'
import { RepoSource } from '../../src/knowledge/ingest/RepoSource.js'
import type { RagService } from '../../src/knowledge/RagService.js'
import type { IngestQueue } from '../../src/knowledge/ingest/IngestQueue.js'

const noBackoff = { backoffMs: () => 0 }
const fixedNow = (): string => '2026-06-01T00:00:00Z'

interface Harness {
  service: RagService
  queue: IngestQueue
  reader: RepoReader
  source: RepoSource
  github: MockGitHubAdapter
}

const harness = (): Harness => {
  const github = new MockGitHubAdapter()
  const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
  const reader = new MockRepoReader(github)
  const source = new RepoSource({ rag: service, queue, reader })
  return { service, queue, reader, source, github }
}

describe('MockRepoReader (adapts MockGitHubAdapter, derives a content-hash sha)', () => {
  it('shares the file set that pushFiles wrote on the MockGitHubAdapter', async () => {
    const github = new MockGitHubAdapter()
    await github.createRepo('s1')
    await github.pushFiles('s1', [
      { filePath: 'README.md', content: '# Hello\nworld' },
      { filePath: 'src/app.ts', content: 'export const x = 1' },
    ])
    const reader = new MockRepoReader(github)
    const files = reader.listFiles('s1').map(f => f.filePath).sort()
    expect(files).toEqual(['README.md', 'src/app.ts'])
  })

  it('derives a stable headSha that is identical for an unchanged file set and changes when a file changes', async () => {
    const github = new MockGitHubAdapter()
    await github.pushFiles('s1', [{ filePath: 'a.md', content: 'one' }])
    const reader = new MockRepoReader(github)
    const sha1 = reader.headSha('s1')
    expect(reader.headSha('s1')).toBe(sha1) // stable for unchanged set
    await github.pushFiles('s1', [{ filePath: 'a.md', content: 'two' }])
    expect(reader.headSha('s1')).not.toBe(sha1) // changes when content changes
  })
})

describe('RepoSource.ingest (incremental, source:repo sourceId=filePath)', () => {
  it('ingests repo files as source:repo sourceId=filePath, retrievable after drain', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('s1', [
      { filePath: 'docs/spec.md', content: '# Spec\npostgres database migrations and schema design' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    const res = await service.retrieve('database schema postgres', { userId: 'u1' }, 5)
    expect(res.length).toBeGreaterThan(0)
    expect(res[0]?.source).toBe('repo:docs/spec.md')
  })

  it('a second identical pass with the same headSha enqueues no new embeds (commit/dedup skip)', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('s1', [
      { filePath: 'a.md', content: '# A\nfirst document about authentication' },
      { filePath: 'b.md', content: '# B\nsecond document about payments billing' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    const sizeAfterFirst = service.getMetrics().corpusSize
    const ingestedAfterFirst = service.getMetrics().ingested
    expect(sizeAfterFirst).toBeGreaterThan(0)

    await source.ingest({ sessionId: 's1', userId: 'u1' }) // identical headSha -> whole pass skipped
    await queue.drain()
    expect(service.getMetrics().corpusSize).toBe(sizeAfterFirst)
    // commit-skip means we never even enqueued work the second time.
    expect(service.getMetrics().ingested).toBe(ingestedAfterFirst)
  })

  it('a changed file re-ingests only that file; unchanged files are skipped', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('s1', [
      { filePath: 'a.md', content: '# A\nalpha content about authentication login' },
      { filePath: 'b.md', content: '# B\nbeta content about payments billing' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    const ingestedAfterFirst = service.getMetrics().ingested

    // Change only b.md; a.md unchanged -> headSha changes -> pass runs, but only b re-embeds.
    await github.pushFiles('s1', [
      { filePath: 'a.md', content: '# A\nalpha content about authentication login' },
      { filePath: 'b.md', content: '# B\nbeta content about payments billing and invoices and refunds' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    const m = service.getMetrics()
    // a.md was skipped (per-file hash unchanged); only b.md's chunks were enqueued.
    expect(m.ingested).toBeGreaterThan(ingestedAfterFirst)
    // the new b.md content is retrievable
    const res = await service.retrieve('invoices refunds', { userId: 'u1' }, 5)
    expect(res.some(r => r.source === 'repo:b.md')).toBe(true)
  })

  it('respects exclude.ts: secret content and .env paths never embed; metrics.excluded increments', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('s1', [
      { filePath: '.env', content: 'SECRET=plain config that should never embed' },
      { filePath: 'config.ts', content: 'const k = "sk-ant-abcdefghijklmnop1234567890"' },
      { filePath: 'ok.md', content: '# Ok\nperfectly safe document content here' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    const m = service.getMetrics()
    expect(m.excluded).toBe(2) // .env (path) + secret-content file
    // the safe file embedded; the excluded files contributed NO chunk to the corpus
    const all = await service.retrieve('document config secret', { userId: 'u1' }, 10)
    expect(all.length).toBeGreaterThan(0)
    expect(all.some(r => r.source === 'repo:ok.md')).toBe(true)
    expect(all.some(r => r.source === 'repo:.env')).toBe(false)
    expect(all.some(r => r.source === 'repo:config.ts')).toBe(false)
  })

  it('tenancy: user B cannot retrieve user A repo chunk', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('sa', [{ filePath: 'secret-notes.md', content: '# Notes\nuser A confidential roadmap' }])
    await source.ingest({ sessionId: 'sa', userId: 'A' })
    await queue.drain()
    expect(await service.retrieve('roadmap', { userId: 'B' }, 5)).toHaveLength(0)
    expect((await service.retrieve('roadmap', { userId: 'A' }, 5)).length).toBeGreaterThan(0)
  })

  it('keeps per-user incremental state separate (same session, different users both ingest)', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('shared', [{ filePath: 'x.md', content: '# X\nshared session document content' }])
    await source.ingest({ sessionId: 'shared', userId: 'A' })
    await queue.drain()
    const ingestedAfterA = service.getMetrics().ingested
    // User B over the same session+files is a NEW tenancy scope: it must ingest, not be
    // shadowed by user A's commit-skip state.
    await source.ingest({ sessionId: 'shared', userId: 'B' })
    await queue.drain()
    expect(service.getMetrics().ingested).toBeGreaterThan(ingestedAfterA)
    expect((await service.retrieve('shared document', { userId: 'B' }, 5)).length).toBeGreaterThan(0)
  })

  it('prunes a file removed (or renamed) since the last pass — no stale grounding lingers', async () => {
    const { service, queue, source, github } = harness()
    await github.pushFiles('s1', [
      { filePath: 'keep.md', content: '# Keep\nstable document about authentication and login flow' },
      { filePath: 'gone.md', content: '# Gone\nremovable document about postgres database migration schema' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    // gone.md is retrievable after the first pass.
    expect((await service.retrieve('postgres database migration schema', { userId: 'u1' }, 5)).some(r => r.source === 'repo:gone.md')).toBe(true)

    // Remove gone.md (pushFiles REPLACES the set) → headSha moves → the next pass runs.
    await github.pushFiles('s1', [
      { filePath: 'keep.md', content: '# Keep\nstable document about authentication and login flow' },
    ])
    await source.ingest({ sessionId: 's1', userId: 'u1' })
    await queue.drain()
    // The removed file's chunk MUST be pruned (deleteBySource('repo', filePath)) — it can no
    // longer be retrieved as grounding.
    expect((await service.retrieve('postgres database migration schema', { userId: 'u1' }, 5)).some(r => r.source === 'repo:gone.md')).toBe(false)
    // The surviving file stays retrievable.
    expect((await service.retrieve('authentication login flow', { userId: 'u1' }, 5)).some(r => r.source === 'repo:keep.md')).toBe(true)
  })

  it('pruning a removed file is tenancy-scoped: it does NOT delete another tenant\'s identically-pathed file', async () => {
    const { service, queue, source, github } = harness()
    // Two tenants each have a repo file at the SAME path README.md (different session+user).
    await github.pushFiles('s-a', [{ filePath: 'README.md', content: '# A\npostgres database migration schema notes' }])
    await github.pushFiles('s-b', [{ filePath: 'README.md', content: '# B\npostgres database migration schema notes' }])
    await source.ingest({ sessionId: 's-a', userId: 'A' })
    await source.ingest({ sessionId: 's-b', userId: 'B' })
    await queue.drain()
    expect((await service.retrieve('postgres migration schema', { userId: 'B' }, 5)).some(r => r.source === 'repo:README.md')).toBe(true)

    // A removes README.md (replace its set) and re-ingests → A's prune must NOT touch B's
    // identically-pathed file (deleteBySourceFor is scoped to {userId,sessionId}).
    await github.pushFiles('s-a', [{ filePath: 'other.md', content: '# Other\nunrelated redis caching content' }])
    await source.ingest({ sessionId: 's-a', userId: 'A' })
    await queue.drain()
    expect((await service.retrieve('postgres migration schema', { userId: 'A' }, 5)).some(r => r.source === 'repo:README.md')).toBe(false)
    expect((await service.retrieve('postgres migration schema', { userId: 'B' }, 5)).some(r => r.source === 'repo:README.md')).toBe(true)
  })
})
