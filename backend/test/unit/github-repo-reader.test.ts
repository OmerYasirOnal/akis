import { describe, it, expect } from 'vitest'
import { RealGitHubRepoReader, type RepoFetch } from '../../src/knowledge/ingest/RealGitHubRepoReader.js'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { MockRepoReader } from '../../src/knowledge/ingest/RepoReader.js'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { EventBus } from '../../src/events/bus.js'

const TOKEN = 'ghp_supersecrettoken_DO_NOT_LEAK'
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/** A canned GitHub REST API: a commit + a recursive tree + per-blob contents. No network. */
interface FakeRepo {
  commitSha: string
  tree: Array<{ path: string; type: 'blob' | 'tree'; sha: string; size?: number }>
  blobs: Record<string, { content: string; encoding: 'base64' | 'utf-8' }>
}

const ok = (body: unknown): Awaited<ReturnType<RepoFetch>> => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/** Build a fake fetch over a canned repo. Records every request (url + headers). */
function fakeFetch(repo: FakeRepo): { fetch: RepoFetch; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const fetch: RepoFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} })
    if (/\/commits\//.test(url)) return ok({ sha: repo.commitSha })
    const treeMatch = /\/git\/trees\/([^?]+)/.exec(url)
    if (treeMatch) return ok({ sha: treeMatch[1], truncated: false, tree: repo.tree })
    const blobMatch = /\/git\/blobs\/([^?]+)/.exec(url)
    if (blobMatch) {
      const blob = repo.blobs[blobMatch[1]!]
      if (!blob) return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => 'not found' }
      return ok({ sha: blobMatch[1], content: blob.content, encoding: blob.encoding })
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => 'unmatched' }
  }
  return { fetch, calls }
}

const sampleRepo = (): FakeRepo => ({
  commitSha: 'abc123def456commitsha',
  tree: [
    { path: 'README.md', type: 'blob', sha: 'blobReadme', size: 12 },
    { path: 'src', type: 'tree', sha: 'treeSrc' },
    { path: 'src/app.ts', type: 'blob', sha: 'blobApp', size: 18 },
  ],
  blobs: {
    blobReadme: { content: b64('# Hello\nworld'), encoding: 'base64' },
    blobApp: { content: b64('export const x = 1'), encoding: 'base64' },
  },
})

describe('RealGitHubRepoReader (offline, injected fetch — GitHub REST API)', () => {
  it('listFiles maps the GitHub tree blobs to {filePath, content} entries (decoded base64)', async () => {
    const { fetch } = fakeFetch(sampleRepo())
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await reader.refresh()
    const files = reader.listFiles('s1').sort((a, b) => a.filePath.localeCompare(b.filePath))
    expect(files).toEqual([
      { filePath: 'README.md', content: '# Hello\nworld' },
      { filePath: 'src/app.ts', content: 'export const x = 1' },
    ])
  })

  it('headSha maps the commit sha of the configured/default ref', async () => {
    const { fetch } = fakeFetch(sampleRepo())
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await reader.refresh()
    expect(reader.headSha('s1')).toBe('abc123def456commitsha')
  })

  it('sends Authorization: Bearer <token> on every request', async () => {
    const { fetch, calls } = fakeFetch(sampleRepo())
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await reader.refresh()
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('targets the configured commits/trees/blobs endpoints for owner/repo/ref', async () => {
    const { fetch, calls } = fakeFetch(sampleRepo())
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', ref: 'develop', token: TOKEN, fetch })
    await reader.refresh()
    const urls = calls.map(c => c.url)
    expect(urls.some(u => u.includes('/repos/me/proj/commits/develop'))).toBe(true)
    expect(urls.some(u => /\/repos\/me\/proj\/git\/trees\/abc123def456commitsha\?recursive=1/.test(u))).toBe(true)
    expect(urls.some(u => u.includes('/repos/me/proj/git/blobs/blobReadme'))).toBe(true)
  })

  it('never leaks the token in a thrown error message (HTTP failure)', async () => {
    const failing: RepoFetch = async () => ({
      ok: false, status: 401, headers: { get: () => null }, json: async () => ({}), text: async () => 'Bad credentials',
    })
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch: failing })
    let thrown: unknown
    try { await reader.refresh() } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    const msg = `${(thrown as Error).message}\n${(thrown as Error).stack ?? ''}`
    expect(msg).not.toContain(TOKEN)
  })

  it('never leaks the token when fetch itself rejects', async () => {
    const boom: RepoFetch = async () => { throw new Error(`network down talking to api with ${TOKEN}`) }
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch: boom })
    let thrown: unknown
    try { await reader.refresh() } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    // The reader must wrap underlying errors so a token embedded in a lower-level message
    // can't propagate.
    expect((thrown as Error).message).not.toContain(TOKEN)
  })

  it('reads its snapshot before refresh as empty (sync interface is safe to call early)', () => {
    const { fetch } = fakeFetch(sampleRepo())
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    expect(reader.listFiles('s1')).toEqual([])
    expect(reader.headSha('s1')).toBe('')
  })

  it('bounds the number of files fetched (maxFiles guard)', async () => {
    const { fetch, calls } = fakeFetch(sampleRepo())
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch, maxFiles: 1 })
    await reader.refresh()
    // Only one blob fetched + capped file set.
    expect(reader.listFiles('s1').length).toBe(1)
    const blobCalls = calls.filter(c => c.url.includes('/git/blobs/'))
    expect(blobCalls.length).toBe(1)
  })

  it('skips oversized blobs (maxBytes guard) without fetching them', async () => {
    const repo = sampleRepo()
    repo.tree = [
      { path: 'small.md', type: 'blob', sha: 'blobReadme', size: 10 },
      { path: 'huge.bin', type: 'blob', sha: 'blobHuge', size: 10_000_000 },
    ]
    const { fetch, calls } = fakeFetch(repo)
    const reader = new RealGitHubRepoReader({ owner: 'me', repo: 'proj', token: TOKEN, fetch, maxBytes: 1024 })
    await reader.refresh()
    expect(reader.listFiles('s1').map(f => f.filePath)).toEqual(['small.md'])
    expect(calls.some(c => c.url.includes('/git/blobs/blobHuge'))).toBe(false)
  })
})

describe('buildRag repo-reader selection (default OFF; opt-in behind AKIS_GITHUB_TOKEN)', () => {
  it('uses the MockRepoReader by default (no env / no token) — zero behavior change', () => {
    const stack = buildRag({ bus: new EventBus() })
    expect(stack.repoReader).toBeInstanceOf(MockRepoReader)
  })

  it('still uses the MockRepoReader when env is present but AKIS_GITHUB_TOKEN is unset', () => {
    const stack = buildRag({ bus: new EventBus(), env: { AKIS_GITHUB_REPO: 'me/proj' } })
    expect(stack.repoReader).toBeInstanceOf(MockRepoReader)
  })

  it('selects RealGitHubRepoReader when AKIS_GITHUB_TOKEN + AKIS_GITHUB_REPO=owner/name are set', () => {
    const stack = buildRag({ bus: new EventBus(), env: { AKIS_GITHUB_TOKEN: TOKEN, AKIS_GITHUB_REPO: 'me/proj' } })
    expect(stack.repoReader).toBeInstanceOf(RealGitHubRepoReader)
  })

  it('selects RealGitHubRepoReader with the split AKIS_GITHUB_OWNER + AKIS_GITHUB_REPO form', () => {
    const stack = buildRag({ bus: new EventBus(), env: { AKIS_GITHUB_TOKEN: TOKEN, AKIS_GITHUB_OWNER: 'me', AKIS_GITHUB_REPO: 'proj' } })
    expect(stack.repoReader).toBeInstanceOf(RealGitHubRepoReader)
  })

  it('falls back to MockRepoReader when the token is set but the repo target is missing (misconfig never breaks boot)', () => {
    const stack = buildRag({ bus: new EventBus(), env: { AKIS_GITHUB_TOKEN: TOKEN } })
    expect(stack.repoReader).toBeInstanceOf(MockRepoReader)
  })

  it('an explicit repoReader override wins over env selection', () => {
    const explicit = new MockRepoReader(new MockGitHubAdapter())
    const stack = buildRag({ bus: new EventBus(), env: { AKIS_GITHUB_TOKEN: TOKEN, AKIS_GITHUB_REPO: 'me/proj' }, repoReader: explicit })
    expect(stack.repoReader).toBe(explicit)
  })
})
