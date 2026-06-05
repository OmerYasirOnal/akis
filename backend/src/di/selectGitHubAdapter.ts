import type { GitHubAdapter } from './MockGitHubAdapter.js'
import { RealGitHubAdapter } from './RealGitHubAdapter.js'

/**
 * P1-CORE-2 — push-adapter selection (OPT-IN). Mirrors the RAG repo-reader switch in
 * buildRag: the REAL adapter is selected ONLY when BOTH AKIS_GITHUB_PUSH_TOKEN and a
 * resolvable AKIS_GITHUB_PUSH_REPO target are set. Otherwise — and ALWAYS under
 * NODE_ENV==='test' — the provided mock is returned (default boot is byte-for-byte
 * identical to today). A misconfigured opt-in (token but no/garbled repo) falls back to
 * the mock rather than throwing, so a bad config can never break boot.
 *
 * The push token is read here and handed to the RealGitHubAdapter as a Bearer credential.
 * It is NEVER logged and never surfaced in any return value, event, or error.
 *
 * Env (separate names from the RAG reader's AKIS_GITHUB_* so push and ingest can target
 * different repos / use different-scoped tokens):
 *  - AKIS_GITHUB_PUSH_TOKEN — required to enable. Fine-grained PAT with `Contents` +
 *    `Pull requests` write (or a GitHub App installation token). Bearer auth; never logged.
 *  - AKIS_GITHUB_PUSH_REPO  — "owner/name" of the target repo. Also accepts an owner+name
 *    split across AKIS_GITHUB_PUSH_OWNER + AKIS_GITHUB_PUSH_REPO.
 *  - AKIS_GITHUB_PUSH_BASE  — optional base branch to open the PR against (default branch
 *    when omitted).
 *  - AKIS_GITHUB_PUSH_API_BASE — optional, for GitHub Enterprise.
 */
export function selectGitHubAdapter(
  env: Record<string, string | undefined> | undefined,
  mock: GitHubAdapter,
): GitHubAdapter {
  // NODE_ENV=test ALWAYS uses the mock — the real adapter never runs in tests/CI.
  if (env?.NODE_ENV === 'test') return mock
  const token = env?.AKIS_GITHUB_PUSH_TOKEN?.trim()
  if (!token) return mock // DEFAULT OFF — no token ⇒ zero behavior change
  const target = resolvePushTarget(env)
  if (!target) return mock // misconfigured opt-in → mock default, never a broken boot
  return new RealGitHubAdapter({
    owner: target.owner,
    repo: target.repo,
    token,
    ...(env?.AKIS_GITHUB_PUSH_BASE?.trim() ? { baseBranch: env.AKIS_GITHUB_PUSH_BASE.trim() } : {}),
    ...(env?.AKIS_GITHUB_PUSH_API_BASE?.trim() ? { apiBase: env.AKIS_GITHUB_PUSH_API_BASE.trim() } : {}),
  })
}

// Owner: GitHub usernames/orgs are 1–39 chars, alphanumeric or single hyphens, no leading
// hyphen (we also forbid a trailing hyphen). Name: GitHub repo names allow letters, digits,
// '.', '_', '-' — but a name of "." / ".." is illegal, and a trailing-dot/'..' is rejected
// below. These guard now-UNTRUSTED user-supplied input (the connect-time owner/name).
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

/** Shape-validate an "owner/name" string into its parts, or undefined when malformed. Used
 *  for BOTH the env push target and the user-supplied connect-time repo. Rejects whitespace,
 *  multiple slashes, leading/trailing hyphens in the owner, and '..' / trailing-dot in the
 *  name — so a bad/hostile target can never form a surprising GitHub URL. */
export function parseOwnerRepo(s: string | undefined): { owner: string; repo: string } | undefined {
  const trimmed = s?.trim()
  if (!trimmed || trimmed.includes('/') === false) return undefined
  const slash = trimmed.indexOf('/')
  if (slash !== trimmed.lastIndexOf('/')) return undefined // exactly one slash
  const owner = trimmed.slice(0, slash)
  const repo = trimmed.slice(slash + 1)
  if (!OWNER_RE.test(owner)) return undefined
  if (!NAME_RE.test(repo)) return undefined
  if (repo === '.' || repo === '..' || repo.includes('..') || repo.endsWith('.')) return undefined
  return { owner, repo }
}

/** Parse the owner/repo push target. Accepts AKIS_GITHUB_PUSH_REPO="owner/name" or the
 *  AKIS_GITHUB_PUSH_OWNER + AKIS_GITHUB_PUSH_REPO pair. Returns undefined when underspecified. */
function resolvePushTarget(
  env: Record<string, string | undefined> | undefined,
): { owner: string; repo: string } | undefined {
  const owner = env?.AKIS_GITHUB_PUSH_OWNER?.trim()
  const repoRaw = env?.AKIS_GITHUB_PUSH_REPO?.trim()
  // Owner+name split across two vars → compose into "owner/name" then validate as one.
  if (owner && repoRaw && !repoRaw.includes('/')) return parseOwnerRepo(`${owner}/${repoRaw}`)
  return parseOwnerRepo(repoRaw)
}
