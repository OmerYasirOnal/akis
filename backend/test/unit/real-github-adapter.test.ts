import { describe, it, expect } from 'vitest'
import { RealGitHubAdapter, GitHubDeliveryError, type PushFetch } from '../../src/di/RealGitHubAdapter.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

const TOKEN = 'ghp_push_supersecrettoken_DO_NOT_LEAK'
const FILES: RepoFile[] = [
  { filePath: 'README.md', content: '# hi\n' },
  { filePath: 'src/app.ts', content: 'export const x = 1\n' },
]

const ok = (body: unknown, status = 200): Awaited<ReturnType<PushFetch>> => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
  text: async () => JSON.stringify(body),
})

/**
 * A canned GitHub REST API that records every request. Models the create-branch /
 * commit-files / open-PR flow. `existingBranch` toggles whether the head ref already
 * exists (→ update path) and `existingPr` whether an open PR for the branch exists.
 */
function fakeGitHub(opts: { existingBranch?: boolean; existingPr?: boolean; repoMissing?: boolean; authedLogin?: string } = {}) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: unknown }> = []
  // The repo starts absent when `repoMissing`; a successful POST /user/repos|/orgs/.../repos flips it on.
  let repoExists = !opts.repoMissing
  const fetch: PushFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, headers: init?.headers ?? {}, body })

    // Authed-user lookup (createRepo decides /user/repos vs /orgs/.../repos from this).
    if (method === 'GET' && /\/user$/.test(url)) {
      return ok({ login: opts.authedLogin ?? 'me' })
    }
    // Create a repo under the authed user or an org.
    if (method === 'POST' && /\/(user|orgs\/[^/]+)\/repos$/.test(url)) {
      repoExists = true
      return ok({ html_url: 'https://github.com/me/proj' }, 201)
    }
    // Default-branch lookup (also the createRepo existence probe). 404 while the repo is absent.
    if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return repoExists ? ok({ default_branch: 'main' }) : ok({ message: 'Not Found' }, 404)
    }
    // Base ref → base commit sha
    if (method === 'GET' && /\/git\/ref\/heads\/main$/.test(url)) {
      return ok({ object: { sha: 'baseCommitSha' } })
    }
    // Head ref existence check (the branch we want to push to)
    if (method === 'GET' && /\/git\/ref\/heads\/akis-/.test(url)) {
      return opts.existingBranch
        ? ok({ object: { sha: 'existingHeadSha' } })
        : ok({ message: 'Not Found' }, 404)
    }
    // Base commit → its tree sha
    if (method === 'GET' && /\/git\/commits\/baseCommitSha$/.test(url)) {
      return ok({ tree: { sha: 'baseTreeSha' } })
    }
    // Create blobs
    if (method === 'POST' && /\/git\/blobs$/.test(url)) {
      return ok({ sha: `blob-${calls.filter(c => /\/git\/blobs$/.test(c.url)).length}` }, 201)
    }
    // Create tree
    if (method === 'POST' && /\/git\/trees$/.test(url)) {
      return ok({ sha: 'newTreeSha' }, 201)
    }
    // Create commit
    if (method === 'POST' && /\/git\/commits$/.test(url)) {
      return ok({ sha: 'newCommitSha' }, 201)
    }
    // Create the branch ref
    if (method === 'POST' && /\/git\/refs$/.test(url)) {
      return ok({ ref: body?.ref, object: { sha: body?.sha } }, 201)
    }
    // Update an existing branch ref
    if (method === 'PATCH' && /\/git\/refs\/heads\/akis-/.test(url)) {
      return ok({ object: { sha: body?.sha } })
    }
    // List PRs for the branch
    if (method === 'GET' && /\/pulls\?/.test(url)) {
      return opts.existingPr
        ? ok([{ number: 7, html_url: 'https://github.com/me/proj/pull/7' }])
        : ok([])
    }
    // Open a PR
    if (method === 'POST' && /\/pulls$/.test(url)) {
      return ok({ number: 42, html_url: 'https://github.com/me/proj/pull/42' }, 201)
    }
    // Update an existing PR
    if (method === 'PATCH' && /\/pulls\/7$/.test(url)) {
      return ok({ number: 7, html_url: 'https://github.com/me/proj/pull/7' })
    }
    return ok({ message: `unmatched ${method} ${url}` }, 500)
  }
  return { fetch, calls }
}

describe('RealGitHubAdapter (offline, injected fetch — GitHub REST API)', () => {
  it('createRepo returns the configured repo HTML URL when the repo already exists (no create POST)', async () => {
    const { fetch, calls } = fakeGitHub()
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    expect(await a.createRepo('sess-1')).toBe('https://github.com/me/proj')
    // An EXISTING repo must NOT be re-created — only the GET existence probe.
    expect(calls.some(c => c.method === 'POST' && /\/repos$/.test(c.url))).toBe(false)
  })

  it('createRepo CREATES the repo when it is missing (404) — POST /user/repos with auto_init', async () => {
    const { fetch, calls } = fakeGitHub({ repoMissing: true, authedLogin: 'me' })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    expect(await a.createRepo('sess-1')).toBe('https://github.com/me/proj')
    const create = calls.find(c => c.method === 'POST' && /\/user\/repos$/.test(c.url))
    expect(create).toBeDefined()
    // auto_init seeds an initial commit so the empty repo is immediately pushable (no 409 on the first push).
    expect((create!.body as { name?: unknown; auto_init?: unknown }).name).toBe('proj')
    expect((create!.body as { auto_init?: unknown }).auto_init).toBe(true)
  })

  it('createRepo creates under an ORG when the configured owner is not the authed user — POST /orgs/{owner}/repos', async () => {
    const { fetch, calls } = fakeGitHub({ repoMissing: true, authedLogin: 'me' })
    const a = new RealGitHubAdapter({ owner: 'acme-org', repo: 'proj', token: TOKEN, fetch })
    expect(await a.createRepo('sess-1')).toBe('https://github.com/acme-org/proj')
    expect(calls.some(c => c.method === 'POST' && /\/orgs\/acme-org\/repos$/.test(c.url))).toBe(true)
    expect(calls.some(c => c.method === 'POST' && /\/user\/repos$/.test(c.url))).toBe(false)
  })

  it('createRepo sends Bearer auth on the create POST and the /user probe, and never leaks the token in the request body', async () => {
    const { fetch, calls } = fakeGitHub({ repoMissing: true, authedLogin: 'me' })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await a.createRepo('sess-1')
    for (const c of calls) expect(c.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    // The token rides ONLY in the Authorization header, never the JSON body of the create POST.
    const create = calls.find(c => c.method === 'POST' && /\/repos$/.test(c.url))!
    expect(JSON.stringify(create.body)).not.toContain(TOKEN)
  })

  it('createRepo then pushFiles works end-to-end against a freshly-created repo', async () => {
    const { fetch } = fakeGitHub({ repoMissing: true, authedLogin: 'me' })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await a.createRepo('sess-1') // creates + auto_init seeds the base commit
    await expect(a.pushFiles('sess-1', FILES)).resolves.toBeUndefined()
  })

  it('pushFiles SEEDS an existing-but-empty repo (no base commit yet) via the contents API, then commits', async () => {
    // A repo that exists but has ZERO commits: the default-branch ref 404s. pushFiles must
    // seed an initial commit (PUT /contents/<path>) so the Git Data API has a base to layer on,
    // instead of surfacing a misleading "repo not reachable".
    const calls: Array<{ method: string; url: string; body?: unknown }> = []
    let seeded = false
    const fetch: PushFetch = async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      calls.push({ method, url, body })
      if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) return ok({ default_branch: 'main' })
      // Base branch ref: 404 until the contents seed creates the first commit.
      if (method === 'GET' && /\/git\/ref\/heads\/main$/.test(url)) {
        return seeded ? ok({ object: { sha: 'baseCommitSha' } }) : ok({ message: 'Not Found' }, 404)
      }
      // Seed the empty repo (creates the initial commit on the default branch).
      if (method === 'PUT' && /\/contents\//.test(url)) { seeded = true; return ok({ commit: { sha: 'seedCommit' } }, 201) }
      if (method === 'GET' && /\/git\/ref\/heads\/akis-/.test(url)) return ok({ message: 'Not Found' }, 404)
      if (method === 'GET' && /\/git\/commits\/baseCommitSha$/.test(url)) return ok({ tree: { sha: 'baseTreeSha' } })
      if (method === 'POST' && /\/git\/blobs$/.test(url)) return ok({ sha: 'blob' }, 201)
      if (method === 'POST' && /\/git\/trees$/.test(url)) return ok({ sha: 'newTreeSha' }, 201)
      if (method === 'POST' && /\/git\/commits$/.test(url)) return ok({ sha: 'newCommitSha' }, 201)
      if (method === 'POST' && /\/git\/refs$/.test(url)) return ok({ object: { sha: body?.sha } }, 201)
      if (method === 'GET' && /\/pulls\?/.test(url)) return ok([])
      if (method === 'POST' && /\/pulls$/.test(url)) return ok({ number: 1 }, 201)
      return ok({ message: `unmatched ${method} ${url}` }, 500)
    }
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'empty', token: TOKEN, fetch })
    await expect(a.pushFiles('sess-1', FILES)).resolves.toBeUndefined()
    expect(calls.some(c => c.method === 'PUT' && /\/contents\//.test(c.url))).toBe(true)
  })

  it('pushFiles tolerates the auto_init seed race (seed PUT 422 "already exists" = repo not empty after all)', async () => {
    // createRepo's auto_init landed but the ref read briefly lagged (GitHub eventual consistency):
    // refShaOrNull saw 404, the redundant seed PUT hits 422 because README.md already exists. The
    // base commit DOES exist, so pushFiles must proceed — not park the run as push_failed.
    let refReads = 0
    const fetch: PushFetch = async (url, init) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(init.body) : undefined
      if (method === 'GET' && /\/repos\/[^/]+\/[^/]+$/.test(url)) return ok({ default_branch: 'main' })
      if (method === 'GET' && /\/git\/ref\/heads\/main$/.test(url)) {
        // First read lags (404) even though auto_init already committed; later reads see the ref.
        refReads++
        return refReads === 1 ? ok({ message: 'Not Found' }, 404) : ok({ object: { sha: 'baseCommitSha' } })
      }
      if (method === 'PUT' && /\/contents\//.test(url)) return ok({ message: 'sha wasn’t supplied' }, 422)
      if (method === 'GET' && /\/git\/ref\/heads\/akis-/.test(url)) return ok({ message: 'Not Found' }, 404)
      if (method === 'GET' && /\/git\/commits\/baseCommitSha$/.test(url)) return ok({ tree: { sha: 'baseTreeSha' } })
      if (method === 'POST' && /\/git\/blobs$/.test(url)) return ok({ sha: 'blob' }, 201)
      if (method === 'POST' && /\/git\/trees$/.test(url)) return ok({ sha: 'newTreeSha' }, 201)
      if (method === 'POST' && /\/git\/commits$/.test(url)) return ok({ sha: 'newCommitSha' }, 201)
      if (method === 'POST' && /\/git\/refs$/.test(url)) return ok({ object: { sha: body?.sha } }, 201)
      if (method === 'GET' && /\/pulls\?/.test(url)) return ok([])
      if (method === 'POST' && /\/pulls$/.test(url)) return ok({ number: 1 }, 201)
      return ok({ message: `unmatched ${method} ${url}` }, 500)
    }
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'lagging', token: TOKEN, fetch })
    await expect(a.pushFiles('sess-1', FILES)).resolves.toBeUndefined()
  })

  it('pushFiles creates a branch, commits the files, and opens a PR (correct REST calls)', async () => {
    const { fetch, calls } = fakeGitHub()
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await a.pushFiles('sess-1', FILES)

    const seq = calls.map(c => `${c.method} ${c.url.replace('https://api.github.com', '')}`)
    // a blob per file
    expect(seq.filter(s => /POST \/repos\/me\/proj\/git\/blobs$/.test(s)).length).toBe(FILES.length)
    // exactly one tree, one commit, one branch-ref create, one PR open
    expect(seq.filter(s => /POST \/repos\/me\/proj\/git\/trees$/.test(s)).length).toBe(1)
    expect(seq.filter(s => /POST \/repos\/me\/proj\/git\/commits$/.test(s)).length).toBe(1)
    expect(seq.filter(s => /POST \/repos\/me\/proj\/git\/refs$/.test(s)).length).toBe(1)
    expect(seq.filter(s => /POST \/repos\/me\/proj\/pulls$/.test(s)).length).toBe(1)
  })

  it('updates the branch (PATCH ref) instead of creating it when it already exists', async () => {
    const { fetch, calls } = fakeGitHub({ existingBranch: true })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await a.pushFiles('sess-1', FILES)
    const methods = calls.map(c => `${c.method} ${c.url}`)
    expect(methods.some(m => /PATCH .*\/git\/refs\/heads\/akis-/.test(m))).toBe(true)
    expect(methods.some(m => /POST .*\/git\/refs$/.test(m))).toBe(false)
  })

  it('updates the existing open PR instead of opening a second one', async () => {
    const { fetch, calls } = fakeGitHub({ existingBranch: true, existingPr: true })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await a.pushFiles('sess-1', FILES)
    const methods = calls.map(c => `${c.method} ${c.url}`)
    expect(methods.some(m => /PATCH .*\/pulls\/7$/.test(m))).toBe(true)
    expect(methods.some(m => /POST .*\/pulls$/.test(m))).toBe(false)
  })

  it('sends Authorization: Bearer <token> on every request', async () => {
    const { fetch, calls } = fakeGitHub()
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    await a.createRepo('sess-1')
    await a.pushFiles('sess-1', FILES)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.headers['Authorization']).toBe(`Bearer ${TOKEN}`)
    }
  })

  it('NEVER leaks the token in any return value (no-leak discipline)', async () => {
    const { fetch } = fakeGitHub()
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch })
    const url = await a.createRepo('sess-1')
    expect(url).not.toContain(TOKEN)
    // pushFiles resolves void — nothing to leak there either.
    await expect(a.pushFiles('sess-1', FILES)).resolves.toBeUndefined()
  })

  it('NEVER leaks the token in a thrown error message (HTTP failure)', async () => {
    const failing: PushFetch = async () => ({
      ok: false, status: 401, headers: { get: () => null }, json: async () => ({ message: 'Bad credentials' }), text: async () => 'Bad credentials',
    })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch: failing })
    let thrown: unknown
    try { await a.pushFiles('sess-1', FILES) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    const msg = `${(thrown as Error).message}\n${(thrown as Error).stack ?? ''}`
    expect(msg).not.toContain(TOKEN)
  })

  it('maps a missing/invalid delivery target (HTTP 404) to a structured GitHubDeliveryError', async () => {
    // The repo target does not exist (or the token cannot see it): the very first request
    // (default-branch lookup) 404s. This must be a recognizable delivery failure, NOT a
    // raw provider Error, so the route can map it to a 4xx + stable code.
    const notFound: PushFetch = async () => ({
      ok: false, status: 404, headers: { get: () => null }, json: async () => ({ message: 'Not Found' }), text: async () => 'Not Found',
    })
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'gone', token: TOKEN, fetch: notFound })
    let thrown: unknown
    try { await a.pushFiles('sess-1', FILES) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GitHubDeliveryError)
    expect((thrown as GitHubDeliveryError).name).toBe('GitHubDeliveryError')
    expect((thrown as GitHubDeliveryError).status).toBe(404)
    // still token-free
    expect(`${(thrown as Error).message}\n${(thrown as Error).stack ?? ''}`).not.toContain(TOKEN)
  })

  it('maps bad credentials (HTTP 401) and rate-limit/forbidden (HTTP 403) to GitHubDeliveryError too', async () => {
    for (const status of [401, 403] as const) {
      const failing: PushFetch = async () => ({
        ok: false, status, headers: { get: () => null }, json: async () => ({ message: 'x' }), text: async () => 'x',
      })
      const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch: failing })
      let thrown: unknown
      try { await a.pushFiles('sess-1', FILES) } catch (e) { thrown = e }
      expect(thrown).toBeInstanceOf(GitHubDeliveryError)
      expect((thrown as GitHubDeliveryError).status).toBe(status)
    }
  })

  it('NEVER leaks the token when fetch itself rejects (wraps lower-level errors)', async () => {
    const boom: PushFetch = async () => { throw new Error(`network down talking to api with ${TOKEN}`) }
    const a = new RealGitHubAdapter({ owner: 'me', repo: 'proj', token: TOKEN, fetch: boom })
    let thrown: unknown
    try { await a.pushFiles('sess-1', FILES) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).not.toContain(TOKEN)
  })
})
