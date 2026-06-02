import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { EventBus } from '../../src/events/bus.js'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { parseUpload, UploadParseError } from '../../src/knowledge/ingest/parse/parseUpload.js'
import { UploadSource } from '../../src/knowledge/ingest/UploadSource.js'
import type { RagService } from '../../src/knowledge/RagService.js'
import type { IngestQueue } from '../../src/knowledge/ingest/IngestQueue.js'

const noBackoff = { backoffMs: () => 0 }
const fixedNow = (): string => '2026-06-01T00:00:00Z'
const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')
const pdfBytes = (): Buffer => readFileSync(resolve(fixturesDir, 'sample.pdf'))

const enc = (s: string): Buffer => Buffer.from(s, 'utf8')

const harness = (): { service: RagService; queue: IngestQueue; source: UploadSource } => {
  const { service, queue } = buildRag({ bus: new EventBus(), queue: noBackoff, now: fixedNow })
  const source = new UploadSource({ rag: service, queue })
  return { service, queue, source }
}

describe('parseUpload (detect kind from filename/mime, parse to text)', () => {
  it('strips markdown frontmatter and keeps the body', async () => {
    const md = '---\ntitle: Spec\ntags: [auth]\n---\n# Heading\nlogin and logout flow body'
    const out = await parseUpload({ filename: 'spec.md', bytes: enc(md) })
    expect(out.kind).toBe('markdown')
    expect(out.text).not.toContain('title: Spec') // frontmatter gone
    expect(out.text).toContain('# Heading')
    expect(out.text).toContain('login and logout flow body')
  })

  it('passes plain text through as prose', async () => {
    const out = await parseUpload({ filename: 'notes.txt', bytes: enc('just some plain prose notes here') })
    expect(out.kind).toBe('prose')
    expect(out.text).toBe('just some plain prose notes here')
  })

  it('detects code by extension', async () => {
    const out = await parseUpload({ filename: 'app.ts', bytes: enc('export const x = 1') })
    expect(out.kind).toBe('code')
    expect(out.text).toContain('export const x = 1')
  })

  it('parses a PDF via pdf-parse to extracted text', async () => {
    const out = await parseUpload({ filename: 'doc.pdf', bytes: pdfBytes() })
    expect(out.kind).toBe('pdf')
    expect(out.text.toLowerCase()).toContain('postgres')
  })

  it('uses mime to detect a PDF even with a misleading filename', async () => {
    const out = await parseUpload({ filename: 'doc', mime: 'application/pdf', bytes: pdfBytes() })
    expect(out.kind).toBe('pdf')
    expect(out.text.toLowerCase()).toContain('postgres')
  })

  it('rejects an unknown extension', async () => {
    await expect(parseUpload({ filename: 'archive.zip', bytes: enc('PK stuff') }))
      .rejects.toBeInstanceOf(UploadParseError)
  })

  it('rejects binary content masquerading as text', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe, 0x00, 0x01, 0x02])
    await expect(parseUpload({ filename: 'blob.txt', bytes: binary }))
      .rejects.toBeInstanceOf(UploadParseError)
  })
})

describe('UploadSource.ingest (source:upload sourceId=filename, trusted SOURCE not ephemeral)', () => {
  it('ingests a markdown upload (frontmatter stripped) and it is retrievable', async () => {
    const { service, queue, source } = harness()
    const md = '---\ntitle: Spec\n---\n# Database\npostgres schema migrations and indexes'
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'spec.md', bytes: enc(md) })
    await queue.drain()
    const res = await service.retrieve('postgres schema migrations', { userId: 'u1' }, 5)
    expect(res.length).toBeGreaterThan(0)
    expect(res[0]?.source).toBe('upload:spec.md')
    // frontmatter never embedded
    expect(JSON.stringify(res)).not.toContain('title: Spec')
  })

  it('ingests a plain text upload and it is retrievable', async () => {
    const { service, queue, source } = harness()
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'notes.txt', bytes: enc('redis caching ttl eviction strategy notes') })
    await queue.drain()
    const res = await service.retrieve('redis cache eviction', { userId: 'u1' }, 5)
    expect(res.some(r => r.source === 'upload:notes.txt')).toBe(true)
  })

  it('parses and ingests a small fixture PDF', async () => {
    const { service, queue, source } = harness()
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'doc.pdf', bytes: pdfBytes() })
    await queue.drain()
    expect(service.getMetrics().corpusSize).toBeGreaterThan(0)
    const res = await service.retrieve('postgres database schema', { userId: 'u1' }, 5)
    expect(res.some(r => r.source === 'upload:doc.pdf')).toBe(true)
  })

  it('re-uploading an identical file dedups (dedupHits >= 1, corpusSize unchanged)', async () => {
    const { service, queue, source } = harness()
    const bytes = enc('# Doc\nidempotent upload content about authentication')
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'spec.md', bytes })
    await queue.drain()
    const size = service.getMetrics().corpusSize
    expect(size).toBeGreaterThan(0)
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'spec.md', bytes })
    await queue.drain()
    expect(service.getMetrics().corpusSize).toBe(size)
    expect(service.getMetrics().dedupHits).toBeGreaterThanOrEqual(1)
  })

  it('rejects an unknown/binary upload without ingesting (no corpus growth)', async () => {
    const { service, queue, source } = harness()
    await expect(source.ingest({ sessionId: 's1', userId: 'u1', filename: 'archive.zip', bytes: enc('PK junk') }))
      .rejects.toBeInstanceOf(UploadParseError)
    await queue.drain()
    expect(service.getMetrics().corpusSize).toBe(0)
  })

  it('excludes a secret inside an upload before embedding (metrics.excluded increments)', async () => {
    const { service, queue, source } = harness()
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'config.md', bytes: enc('# Config\nkey sk-ant-abcdefghijklmnop1234567890') })
    await queue.drain()
    expect(service.getMetrics().excluded).toBeGreaterThanOrEqual(1)
    const all = await service.retrieve('config key', { userId: 'u1' }, 5)
    expect(all.some(r => r.source === 'upload:config.md')).toBe(false)
  })

  it('deleteBySource("upload", filename) forgets the doc (right-to-forget)', async () => {
    const { service, queue, source } = harness()
    await source.ingest({ sessionId: 's1', userId: 'u1', filename: 'spec.md', bytes: enc('# Forget\nremovable upload document about payments billing') })
    await queue.drain()
    expect((await service.retrieve('payments billing', { userId: 'u1' }, 5)).length).toBeGreaterThan(0)
    const removed = service.deleteBySource('upload', 'spec.md')
    expect(removed).toBeGreaterThan(0)
    expect(await service.retrieve('payments billing', { userId: 'u1' }, 5)).toHaveLength(0)
  })

  it('tenancy: user B cannot retrieve user A upload chunk', async () => {
    const { service, queue, source } = harness()
    await source.ingest({ sessionId: 'sa', userId: 'A', filename: 'a.md', bytes: enc('# A\nuser A confidential upload roadmap') })
    await queue.drain()
    expect(await service.retrieve('roadmap', { userId: 'B' }, 5)).toHaveLength(0)
    expect((await service.retrieve('roadmap', { userId: 'A' }, 5)).length).toBeGreaterThan(0)
  })
})
