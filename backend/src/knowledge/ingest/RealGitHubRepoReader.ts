import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { RepoReader } from './RepoReader.js'

/**
 * Real GitHub-backed RepoReader (issue #7 AC1 follow-up) — the opt-in counterpart to
 * MockRepoReader, selected ONLY when AKIS_GITHUB_TOKEN is set (default stays the mock).
 *
 * Trust posture is UNCHANGED: this reads the user's OWN configured repo (owner/repo/ref
 * from env), the same "user's own code is trusted grounding" posture as the mock. It does
 * NOT open the trusted-grounding model to arbitrary third-party repos.
 *
 * Shape problem: RepoReader is SYNCHRONOUS (listFiles/headSha return immediately), but the
 * GitHub REST API is async. So the reader keeps an in-memory SNAPSHOT (exactly like the
 * MockGitHubAdapter's in-memory store) and serves the sync reads from it. `refresh()` does
 * the async work (commit + recursive tree + bounded blob fetch) and swaps the snapshot in.
 * Before the first refresh the snapshot is empty → listFiles=[] / headSha='' → RepoSource's
 * pass is a clean no-op (it enqueues nothing), never a throw.
 *
 * `sessionId` is ignored: this reader is bound to ONE configured repo, so every session
 * reads the same target. (The mock is multi-session because it stands in for per-session
 * pushed repos; the real reader points at the operator's single repo.)
 *
 * GitHub REST endpoints used (all authenticated with `Authorization: Bearer <token>`):
 *  - GET /repos/{owner}/{repo}/commits/{ref}            → `.sha` is the head commit → headSha
 *  - GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1 → blob entries (path/sha/size)
 *  - GET /repos/{owner}/{repo}/git/blobs/{sha}          → base64 `.content` → decoded text
 *
 * Defensive + bounded: a non-OK response throws a TOKEN-FREE error; the file count is
 * capped (maxFiles), oversized blobs are skipped by the tree `size` BEFORE fetching
 * (maxBytes), and a truncated tree is honored as a partial set rather than looping.
 *
 * Holds NO gate capability — it only reads source content.
 */

/** Minimal injected HTTP surface — global `fetch` in prod, a canned stub in tests (OFFLINE).
 *  Deliberately narrow so a unit test can satisfy it without the DOM fetch types. */
export type RepoFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface RealGitHubRepoReaderConfig {
  owner: string
  repo: string
  /** Branch / tag / commit-ish to read. Defaults to the repo's default branch via `HEAD`. */
  ref?: string
  /** AKIS_GITHUB_TOKEN — sent as a Bearer token, NEVER logged or surfaced in errors. */
  token: string
  /** Injected HTTP client. Defaults to Node's global `fetch`; tests inject a fake (no network). */
  fetch?: RepoFetch
  /** GitHub API base (override for GH Enterprise). Defaults to the public API. */
  apiBase?: string
  /** Cap on the number of files ingested per pass (bound a huge repo). Default 5000. */
  maxFiles?: number
  /** Skip any blob whose tree `size` exceeds this many bytes (bound a huge file). Default 1 MiB. */
  maxBytes?: number
}

interface TreeEntry { path?: unknown; type?: unknown; sha?: unknown; size?: unknown }

const DEFAULT_MAX_FILES = 5000
const DEFAULT_MAX_BYTES = 1024 * 1024

/** Adapt the global fetch to the narrow RepoFetch surface (tests inject their own). */
const defaultFetch: RepoFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<RepoFetch>

export class RealGitHubRepoReader implements RepoReader {
  private readonly fetch: RepoFetch
  private readonly apiBase: string
  private readonly maxFiles: number
  private readonly maxBytes: number
  // The async-populated snapshot the sync interface serves from.
  private snapshot: { sha: string; files: RepoFile[] } = { sha: '', files: [] }

  constructor(private readonly cfg: RealGitHubRepoReaderConfig) {
    this.fetch = cfg.fetch ?? defaultFetch
    this.apiBase = (cfg.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
    this.maxFiles = cfg.maxFiles && cfg.maxFiles > 0 ? cfg.maxFiles : DEFAULT_MAX_FILES
    this.maxBytes = cfg.maxBytes && cfg.maxBytes > 0 ? cfg.maxBytes : DEFAULT_MAX_BYTES
  }

  /** Sync read of the current snapshot (empty until the first refresh). sessionId ignored. */
  listFiles(_sessionId: string): RepoFile[] {
    return [...this.snapshot.files]
  }

  /** Sync head sha of the current snapshot ('' until the first refresh). sessionId ignored. */
  headSha(_sessionId: string): string {
    return this.snapshot.sha
  }

  /**
   * Fetch the head commit + recursive tree + bounded blob contents and atomically swap the
   * snapshot in. Throws a TOKEN-FREE error on any HTTP/network failure (the caller decides
   * whether to surface or swallow it; RepoSource is never on this path directly).
   */
  async refresh(): Promise<void> {
    const { owner, repo } = this.cfg
    const ref = this.cfg.ref ?? 'HEAD'
    // 1. head commit of the configured/default ref → headSha
    const commit = await this.getJson(`/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}`)
    const sha = asString((commit as { sha?: unknown }).sha)
    if (!sha) throw new Error('github: commit response had no sha')

    // 2. recursive tree at that commit → blob entries (path/sha/size)
    const treeRes = await this.getJson(`/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(sha)}?recursive=1`)
    const rawTree = (treeRes as { tree?: unknown }).tree
    const entries: TreeEntry[] = Array.isArray(rawTree) ? (rawTree as TreeEntry[]) : []

    // 3. fetch each in-bounds blob, decode to text
    const files: RepoFile[] = []
    for (const e of entries) {
      if (files.length >= this.maxFiles) break // bound a huge repo
      if (e.type !== 'blob') continue // skip subtrees / submodules / symlinks
      const path = asString(e.path)
      const blobSha = asString(e.sha)
      if (!path || !blobSha) continue
      const size = typeof e.size === 'number' ? e.size : 0
      if (size > this.maxBytes) continue // skip oversized files BEFORE fetching the blob
      const blob = await this.getJson(`/repos/${enc(owner)}/${enc(repo)}/git/blobs/${enc(blobSha)}`)
      const content = decodeBlob(blob)
      if (content === undefined) continue // unreadable/binary encoding → skip, don't poison
      files.push({ filePath: path, content })
    }
    // Atomic swap: a concurrent listFiles() sees either the old or the new set, never partial.
    this.snapshot = { sha, files }
  }

  /** Authenticated GET returning parsed JSON. Bearer auth; errors carry NO token. */
  private async getJson(path: string): Promise<unknown> {
    const url = `${this.apiBase}${path}`
    let res: Awaited<ReturnType<RepoFetch>>
    try {
      res = await this.fetch(url, {
        method: 'GET',
        headers: {
          // AKIS_GITHUB_TOKEN as a Bearer token. NEVER logged.
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'akis-platform',
        },
      })
    } catch {
      // Wrap: a lower-level error message could (in theory) echo the request incl. the token.
      // Re-throw a fixed, token-free message so nothing downstream can leak it.
      throw new Error(`github: request to ${path} failed`)
    }
    if (!res.ok) {
      // Defensive rate-limit / error guard. Surface the STATUS only — never the body (which
      // GitHub may echo with request context) and never the token.
      if (res.status === 403 || res.status === 429) {
        throw new Error(`github: rate limited or forbidden (HTTP ${res.status})`)
      }
      throw new Error(`github: request to ${path} failed (HTTP ${res.status})`)
    }
    return res.json()
  }
}

/** Decode a GitHub blob payload to text. base64 (the default) is decoded; an explicit
 *  utf-8 payload is taken as-is; anything else is treated as unreadable (returns undefined). */
function decodeBlob(blob: unknown): string | undefined {
  const b = blob as { content?: unknown; encoding?: unknown }
  const content = asString(b.content)
  if (content === undefined) return undefined
  const encoding = asString(b.encoding) ?? 'base64'
  if (encoding === 'base64') {
    // GitHub wraps base64 in newlines; Buffer ignores them.
    return Buffer.from(content, 'base64').toString('utf8')
  }
  if (encoding === 'utf-8' || encoding === 'utf8') return content
  return undefined
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** Percent-encode a path segment (owner/repo/ref/sha) so a stray char can't break the URL.
 *  A ref like `feature/x` keeps its slash (GitHub accepts it in the commits path). */
const enc = (s: string): string => encodeURIComponent(s).replace(/%2F/gi, '/')
