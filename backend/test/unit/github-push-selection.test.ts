import { describe, it, expect } from 'vitest'
import { selectGitHubAdapter, parseOwnerRepo } from '../../src/di/selectGitHubAdapter.js'
import { MockGitHubAdapter } from '../../src/di/MockGitHubAdapter.js'
import { RealGitHubAdapter } from '../../src/di/RealGitHubAdapter.js'

const TOKEN = 'ghp_push_supersecrettoken_DO_NOT_LEAK'
/** Non-test env so the NODE_ENV==='test' short-circuit doesn't force the mock. */
const PROD = { NODE_ENV: 'production' as const }
const mock = (): MockGitHubAdapter => new MockGitHubAdapter()

describe('selectGitHubAdapter (opt-in: real ONLY when token + repo set AND not NODE_ENV=test)', () => {
  it('returns the provided mock by default (no env) — zero behavior change', () => {
    const m = mock()
    expect(selectGitHubAdapter(undefined, m)).toBe(m)
  })

  it('returns the mock when only the token is set (repo target missing)', () => {
    const m = mock()
    expect(selectGitHubAdapter({ ...PROD, AKIS_GITHUB_PUSH_TOKEN: TOKEN }, m)).toBe(m)
  })

  it('returns the mock when only the repo is set (token missing)', () => {
    const m = mock()
    expect(selectGitHubAdapter({ ...PROD, AKIS_GITHUB_PUSH_REPO: 'me/proj' }, m)).toBe(m)
  })

  it('selects the RealGitHubAdapter when BOTH token + repo are set (owner/name form)', () => {
    const got = selectGitHubAdapter({ ...PROD, AKIS_GITHUB_PUSH_TOKEN: TOKEN, AKIS_GITHUB_PUSH_REPO: 'me/proj' }, mock())
    expect(got).toBeInstanceOf(RealGitHubAdapter)
  })

  it('falls back to the mock when the repo target is malformed (no slash, no split owner)', () => {
    const m = mock()
    expect(selectGitHubAdapter({ ...PROD, AKIS_GITHUB_PUSH_TOKEN: TOKEN, AKIS_GITHUB_PUSH_REPO: 'bogus' }, m)).toBe(m)
  })

  it('ALWAYS returns the mock under NODE_ENV=test, even with token + repo set', () => {
    const m = mock()
    const got = selectGitHubAdapter({ NODE_ENV: 'test', AKIS_GITHUB_PUSH_TOKEN: TOKEN, AKIS_GITHUB_PUSH_REPO: 'me/proj' }, m)
    expect(got).toBe(m)
  })
})

describe('parseOwnerRepo (shape-validates now-untrusted user input)', () => {
  it('accepts a well-formed owner/name', () => {
    expect(parseOwnerRepo('ada/app')).toEqual({ owner: 'ada', repo: 'app' })
    expect(parseOwnerRepo('  Ada-Lovelace/my.cool_repo-1  ')).toEqual({ owner: 'Ada-Lovelace', repo: 'my.cool_repo-1' })
  })

  it('rejects missing / empty / no-slash', () => {
    expect(parseOwnerRepo(undefined)).toBeUndefined()
    expect(parseOwnerRepo('')).toBeUndefined()
    expect(parseOwnerRepo('justname')).toBeUndefined()
  })

  it('rejects multiple slashes', () => {
    expect(parseOwnerRepo('a/b/c')).toBeUndefined()
  })

  it('rejects whitespace inside, leading/trailing owner hyphens', () => {
    expect(parseOwnerRepo('a b/c')).toBeUndefined()
    expect(parseOwnerRepo('-ada/app')).toBeUndefined()
    expect(parseOwnerRepo('ada-/app')).toBeUndefined()
  })

  it('rejects path-traversal-ish repo names ("..", trailing dot)', () => {
    expect(parseOwnerRepo('ada/..')).toBeUndefined()
    expect(parseOwnerRepo('ada/a..b')).toBeUndefined()
    expect(parseOwnerRepo('ada/app.')).toBeUndefined()
    expect(parseOwnerRepo('ada/.')).toBeUndefined()
  })

  it('rejects an over-long owner (>39 chars)', () => {
    expect(parseOwnerRepo(`${'a'.repeat(40)}/app`)).toBeUndefined()
  })
})
