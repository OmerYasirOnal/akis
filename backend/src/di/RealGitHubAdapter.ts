import type { GitHubAdapter, RepoFile } from './MockGitHubAdapter.js'

/**
 * A KNOWN GitHub delivery failure: the configured push target rejected the request
 * (missing/invalid repo → 404, bad/expired token → 401, forbidden/rate-limited → 403/429,
 * unprocessable → 422). This is a CLIENT-side misconfiguration of the delivery target, not
 * an AKIS internal fault, so the route maps it to a 4xx with the stable `GitHubDeliveryError`
 * code instead of a raw 500 — the FE then shows a localized "push destination" message rather
 * than leaking the raw English provider string. The message stays TOKEN-FREE (status only,
 * never the response body) exactly like the plain errors it replaces. Gate-neutral: the push
 * gate already parks the run `push_failed` (retryable) on any throw; this only reshapes the
 * thrown error, never whether/how the push is authorized.
 */
export class GitHubDeliveryError extends Error {
  /** Stable error code surfaced to the FE (drives the i18n key). */
  readonly code = 'GitHubDeliveryError'
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'GitHubDeliveryError'
  }
}

/**
 * Real GitHub-backed push adapter (P1-CORE-2) — the opt-in counterpart to
 * MockGitHubAdapter, selected ONLY when AKIS_GITHUB_PUSH_TOKEN + AKIS_GITHUB_PUSH_REPO
 * are both set (and never under NODE_ENV=test). It implements the SAME `GitHubAdapter`
 * seam the push gate (`pushToGitHub`) consumes, so it is reachable ONLY through the
 * unchanged ApprovedPush-gated path — there is no new way to push.
 *
 * `pushFiles` performs a real publish via the GitHub REST Git Data API + Pulls API:
 *  1. resolve the base branch (configured `baseBranch`, else the repo default branch)
 *  2. read the base commit + its tree sha
 *  3. create a blob per file → create a tree → create a commit on top of the base
 *  4. create (or fast-forward update) the session's `akis-<sessionId>` branch ref
 *  5. open a PR base←head, or update the existing open PR for that branch
 *
 * Mirrors RealGitHubRepoReader's discipline exactly: a narrow injected `fetch` (real
 * global fetch in prod, a canned stub in tests — OFFLINE), `Authorization: Bearer <token>`
 * on every request, and TOKEN-FREE errors (a non-OK response surfaces the STATUS only,
 * never the body, and a thrown lower-level error is re-wrapped). The token is NEVER
 * logged and never appears in any return value, event, or error.
 *
 * Holds NO gate capability — `pushToGitHub` only calls it AFTER minting a valid
 * ApprovedPush (verified session + code-digest match).
 */

/** Narrow injected HTTP surface — global `fetch` in prod, a canned stub in tests (OFFLINE).
 *  Deliberately minimal so a unit test can satisfy it without the DOM fetch types. */
export type PushFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface RealGitHubAdapterConfig {
  owner: string
  repo: string
  /** AKIS_GITHUB_PUSH_TOKEN — sent as a Bearer token, NEVER logged or surfaced in errors. */
  token: string
  /** Base branch to open the PR against. Defaults to the repo's default branch. */
  baseBranch?: string
  /** Injected HTTP client. Defaults to Node's global `fetch`; tests inject a fake (no network). */
  fetch?: PushFetch
  /** GitHub API base (override for GH Enterprise). Defaults to the public API. */
  apiBase?: string
}

/** Adapt the global fetch to the narrow PushFetch surface (tests inject their own). */
const defaultFetch: PushFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<PushFetch>

export class RealGitHubAdapter implements GitHubAdapter {
  private readonly fetch: PushFetch
  private readonly apiBase: string

  constructor(private readonly cfg: RealGitHubAdapterConfig) {
    this.fetch = cfg.fetch ?? defaultFetch
    this.apiBase = (cfg.apiBase ?? 'https://api.github.com').replace(/\/+$/, '')
  }

  /** The destination repo's HTML URL (no network needed). The mock's createRepo seeds an
   *  in-memory repo; the real target already exists, so this just returns its URL. */
  async createRepo(_sessionId: string): Promise<string> {
    return `https://github.com/${this.cfg.owner}/${this.cfg.repo}`
  }

  /** No local store — reads belong to the RAG real reader (a separate concern). */
  read(_sessionId: string): RepoFile[] {
    return []
  }

  /**
   * Publish `files` as a branch + commit + PR. Idempotent per session: re-pushing the
   * same set updates the same `akis-<sessionId>` branch and the same open PR rather than
   * stacking duplicates. Throws a TOKEN-FREE error on any HTTP/network failure.
   */
  async pushFiles(sessionId: string, files: RepoFile[]): Promise<void> {
    const branch = `akis-${sanitizeRef(sessionId)}`
    const base = this.cfg.baseBranch?.trim() || (await this.defaultBranch())

    // Base commit + its tree (the new tree is layered on top of it).
    const baseSha = await this.refSha(base)
    const baseCommit = await this.getJson(`/git/commits/${enc(baseSha)}`)
    const baseTreeSha = asString((baseCommit as { tree?: { sha?: unknown } }).tree?.sha)
    if (!baseTreeSha) throw new Error('github: base commit had no tree sha')

    // One blob per file → a tree → a commit on top of the base.
    const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string }> = []
    for (const f of files) {
      const blob = await this.postJson('/git/blobs', { content: f.content, encoding: 'utf-8' })
      const blobSha = asString((blob as { sha?: unknown }).sha)
      if (!blobSha) throw new Error('github: blob create returned no sha')
      tree.push({ path: f.filePath, mode: '100644', type: 'blob', sha: blobSha })
    }
    const newTree = await this.postJson('/git/trees', { base_tree: baseTreeSha, tree })
    const newTreeSha = asString((newTree as { sha?: unknown }).sha)
    if (!newTreeSha) throw new Error('github: tree create returned no sha')

    const commit = await this.postJson('/git/commits', {
      message: `AKIS build ${sessionId}`,
      tree: newTreeSha,
      parents: [baseSha],
    })
    const commitSha = asString((commit as { sha?: unknown }).sha)
    if (!commitSha) throw new Error('github: commit create returned no sha')

    // Create or fast-forward the session branch ref.
    const existing = await this.refShaOrNull(branch)
    if (existing === null) {
      await this.postJson('/git/refs', { ref: `refs/heads/${branch}`, sha: commitSha })
    } else {
      await this.patchJson(`/git/refs/heads/${enc(branch)}`, { sha: commitSha, force: true })
    }

    // Open a PR base←branch, or update the existing open one (idempotent per session).
    await this.openOrUpdatePr(branch, base, sessionId)
  }

  /** GET the repo to read its default branch. */
  private async defaultBranch(): Promise<string> {
    const repo = await this.getJson('')
    return asString((repo as { default_branch?: unknown }).default_branch) ?? 'main'
  }

  /** The commit sha a branch ref points at (throws if the ref is missing). */
  private async refSha(branch: string): Promise<string> {
    const ref = await this.getJson(`/git/ref/heads/${enc(branch)}`)
    const sha = asString((ref as { object?: { sha?: unknown } }).object?.sha)
    if (!sha) throw new Error(`github: ref heads/${branch} had no sha`)
    return sha
  }

  /** The commit sha a branch ref points at, or null when the ref does not exist (404). */
  private async refShaOrNull(branch: string): Promise<string | null> {
    const res = await this.send('GET', `/git/ref/heads/${enc(branch)}`)
    if (res.status === 404) return null
    if (!res.ok) throw this.httpError('git/ref', res.status)
    const sha = asString(((await res.json()) as { object?: { sha?: unknown } }).object?.sha)
    return sha ?? null
  }

  /** Open a PR for `branch`→`base`, or update the title/body of the existing open one. */
  private async openOrUpdatePr(branch: string, base: string, sessionId: string): Promise<void> {
    const head = `${this.cfg.owner}:${branch}`
    const list = await this.getJson(`/pulls?head=${enc(head)}&state=open`)
    const open = Array.isArray(list) ? (list as Array<{ number?: unknown }>) : []
    const title = `AKIS build ${sessionId}`
    const body = 'Opened by AKIS after all 4 structural gates passed (spec approval → no pre-approval code → real ≥1-test verification → digest-bound ApprovedPush).'
    const num = open.length > 0 ? asNumber(open[0]?.number) : undefined
    if (num !== undefined) {
      await this.patchJson(`/pulls/${num}`, { title, body })
    } else {
      await this.postJson('/pulls', { title, head: branch, base, body })
    }
  }

  // ── HTTP plumbing (Bearer auth; TOKEN-FREE errors) ─────────────────────────────

  private async getJson(path: string): Promise<unknown> {
    const res = await this.send('GET', path)
    if (!res.ok) throw this.httpError(path, res.status)
    return res.json()
  }

  private async postJson(path: string, body: unknown): Promise<unknown> {
    const res = await this.send('POST', path, body)
    if (!res.ok) throw this.httpError(path, res.status)
    return res.json()
  }

  private async patchJson(path: string, body: unknown): Promise<unknown> {
    const res = await this.send('PATCH', path, body)
    if (!res.ok) throw this.httpError(path, res.status)
    return res.json()
  }

  /** One request. `path` is appended to /repos/{owner}/{repo}. Bearer auth; the catch
   *  re-throws a fixed TOKEN-FREE message so no lower-level error can echo the token. */
  private async send(method: string, path: string, body?: unknown): Promise<Awaited<ReturnType<PushFetch>>> {
    const url = `${this.apiBase}/repos/${enc(this.cfg.owner)}/${enc(this.cfg.repo)}${path}`
    try {
      return await this.fetch(url, {
        method,
        headers: {
          // AKIS_GITHUB_PUSH_TOKEN as a Bearer token. NEVER logged.
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'akis-platform',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      // A lower-level error could (in theory) echo the request incl. the token — re-throw
      // a fixed, token-free message so nothing downstream can leak it.
      throw new Error(`github: ${method} request to ${path || '/'} failed`)
    }
  }

  /** A token-free, STRUCTURED HTTP error: STATUS only, never the response body. Returns a
   *  GitHubDeliveryError so the route can map a known delivery-target failure to a 4xx +
   *  stable code (the FE localizes it) instead of leaking the raw provider string as a 500. */
  private httpError(path: string, status: number): GitHubDeliveryError {
    if (status === 403 || status === 429) return new GitHubDeliveryError(`github: rate limited or forbidden (HTTP ${status})`, status)
    return new GitHubDeliveryError(`github: request to ${path || '/'} failed (HTTP ${status})`, status)
  }
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** Percent-encode a path segment so a stray char can't break the URL; keep slashes in
 *  a ref like `feature/x` (GitHub accepts them in the ref path). */
const enc = (s: string): string => encodeURIComponent(s).replace(/%2F/gi, '/')

/** A session id may contain chars that are illegal in a git ref. Replace anything outside
 *  [A-Za-z0-9._-] with '-' so `akis-<sessionId>` is always a valid branch name. */
const sanitizeRef = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '-')
