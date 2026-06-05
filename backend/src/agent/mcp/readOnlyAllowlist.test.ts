/**
 * GATE-SAFETY contract for the read-only positive allow-list (SP1).
 *
 * This module is the defense-in-depth check at the MCP bridge — INDEPENDENT of the
 * server's own --read-only flag — so these tests pin its safety property structurally,
 * with NO real Docker/network: the module is a pure frozen Set + one predicate.
 *
 * The three properties we lock, in priority order:
 *   1. EVERY allowlisted name is a structural read (a get_, list_ or search_ verb, or one of
 *      the two documented consolidated read dispatchers). A future edit that smuggles a
 *      mutation name onto the set fails here.
 *   2. EVERY known mutation prefix (create_, update_, delete_, push_, merge_, fork_, add_, …)
 *      is REJECTED — a write tool can never surface to an agent even if the server advertises it.
 *   3. Unknown / novel tool names are REJECTED BY DEFAULT — this is a positive allow-list,
 *      not a denylist, so anything we did not explicitly vet is inert.
 */
import { describe, it, expect } from 'vitest'
import { GITHUB_READONLY_TOOLS, isReadOnlyTool } from './readOnlyAllowlist.js'

/**
 * The two consolidated read dispatchers are read-only by NAME-shape exception: they end in
 * `_read` and (per the module doc) lean ALSO on GITHUB_READ_ONLY=1. We treat them as the
 * only legitimate non-(get|list|search)-prefixed admissions, so property #1 stays exact
 * rather than a loophole that would let any name through.
 */
const READ_DISPATCHERS = new Set<string>(['issue_read', 'pull_request_read'])

/** A name is structurally a read iff it is a get/list/search verb OR an allowed read dispatcher. */
function isStructuralRead(name: string): boolean {
  return (
    name.startsWith('get_') ||
    name.startsWith('list_') ||
    name.startsWith('search_') ||
    READ_DISPATCHERS.has(name)
  )
}

describe('GITHUB_READONLY_TOOLS — positive read-only allow-list', () => {
  it('is non-empty (the bridge would admit nothing otherwise)', () => {
    // A silently-empty set would degrade to "no github tools" — honest, but here it would
    // mask a broken set, so we assert it actually carries the vetted reads.
    expect(GITHUB_READONLY_TOOLS.size).toBeGreaterThan(0)
  })

  it('contains ONLY structural reads — every member is a get_/list_/search_ verb or a read dispatcher', () => {
    // PROPERTY #1: this is the heart of GATE-SAFETY. If anyone ever adds a mutation name to the
    // set, this fails listing the exact offender(s) — no write verb can hide on the allow-list.
    const offenders = [...GITHUB_READONLY_TOOLS].filter(name => !isStructuralRead(name))
    expect(offenders).toEqual([])
  })

  it('carries no name with a known mutation prefix', () => {
    // Belt-and-braces on #1, phrased as the denylist we are NOT (but must still never violate):
    // even if a future read-shaped alias collided with a write prefix, this catches it.
    const MUTATION_PREFIXES = [
      'create_',
      'update_',
      'delete_',
      'push_',
      'merge_',
      'fork_',
      'add_',
      'remove_',
      'edit_',
      'set_',
      'close_',
      'open_',
      'request_', // e.g. request_copilot_review — a write
    ]
    const mutating = [...GITHUB_READONLY_TOOLS].filter(name =>
      MUTATION_PREFIXES.some(p => name.startsWith(p)),
    )
    expect(mutating).toEqual([])
  })

  it('is FROZEN — cannot be mutated at runtime to widen the gate', () => {
    // Defense-in-depth: the set is Object.freeze'd, so a compromised/buggy caller cannot
    // .add() a write name into the live allow-list. In strict mode .add on a frozen Set throws.
    expect(Object.isFrozen(GITHUB_READONLY_TOOLS)).toBe(true)
    // The cast mirrors how a malicious/buggy caller would reach past the ReadonlySet type.
    const mutable = GITHUB_READONLY_TOOLS as unknown as Set<string>
    expect(() => mutable.add('push_files')).toThrow()
    expect(GITHUB_READONLY_TOOLS.has('push_files')).toBe(false)
  })

  it('admits the specific repository/code reads the pinned image advertises', () => {
    // Snapshot of the structurally-read, single-purpose tools we vetted. Keeps the set honest
    // against drift: dropping one of these silently is a regression of capability.
    for (const name of [
      'get_file_contents',
      'search_code',
      'search_repositories',
      'list_commits',
      'get_commit',
      'list_branches',
      'list_tags',
      'list_pull_requests',
      'list_issues',
      'search_issues',
    ]) {
      expect(GITHUB_READONLY_TOOLS.has(name)).toBe(true)
    }
  })

  it('admits the two consolidated read dispatchers', () => {
    expect(GITHUB_READONLY_TOOLS.has('issue_read')).toBe(true)
    expect(GITHUB_READONLY_TOOLS.has('pull_request_read')).toBe(true)
  })

  it('EXACTLY matches the read tools verified against the PINNED image (no extra, no missing)', () => {
    // The allow-list↔image correspondence guarantee, made concrete: this EXACT set was verified
    // against the read tools the pinned StdioDockerTransport.IMAGE advertises under the
    // `repos,issues,pull_requests` toolsets (github-mcp-server rev 457f59932, pkg/github/
    // {repositories,issues,pullrequests,search}.go — every name below is a real `mcp.NewTool`
    // name there). A future image-bump that adds/removes a read tool must update BOTH the IMAGE
    // digest AND this snapshot together, so the documented "rebuilt from the pinned image" claim
    // can never silently drift to a placeholder/unverified state again.
    const VERIFIED_AGAINST_IMAGE = [
      'get_file_contents',
      'search_code',
      'search_repositories',
      'list_commits',
      'get_commit',
      'list_branches',
      'list_tags',
      'list_pull_requests',
      'list_issues',
      'search_issues',
      'issue_read',
      'pull_request_read',
    ].sort()
    expect([...GITHUB_READONLY_TOOLS].sort()).toEqual(VERIFIED_AGAINST_IMAGE)
  })
})

describe('isReadOnlyTool — the single admission predicate', () => {
  it('agrees with the set membership for every allowlisted name', () => {
    // The bridge uses isReadOnlyTool() as the gate; it MUST be a faithful view of the set.
    for (const name of GITHUB_READONLY_TOOLS) {
      expect(isReadOnlyTool(name)).toBe(true)
    }
  })

  it('REJECTS every known mutation tool name (no write tool ever reaches an agent)', () => {
    // PROPERTY #2: the exact write/mutation names the official server can advertise. Each one
    // hitting `true` would be a gate breach, so we enumerate the dangerous surface explicitly.
    const MUTATIONS = [
      'create_or_update_file',
      'create_repository',
      'create_branch',
      'create_issue',
      'create_pull_request',
      'create_pull_request_review',
      'update_issue',
      'update_pull_request_branch',
      'delete_file',
      'push_files',
      'merge_pull_request',
      'fork_repository',
      'add_issue_comment',
      'add_pull_request_review_comment',
      'remove_collaborator',
      'request_copilot_review',
    ]
    for (const name of MUTATIONS) {
      expect(isReadOnlyTool(name)).toBe(false)
    }
  })

  it('REJECTS unknown / novel tool names by default (positive allow-list, not a denylist)', () => {
    // PROPERTY #3: a name we never vetted — even one that LOOKS like a read — is rejected,
    // because admission is membership in the frozen set, not absence from a blocklist. This is
    // what makes a brand-new server tool inert until a human adds it deliberately.
    const NOVEL = [
      'totally_new_tool',
      'get_secret_scanning_alert', // read-SHAPED but not on the vetted set → still rejected
      'list_secret_scanning_alerts',
      'search_users',
      'get_me',
      'star_repository',
      '', // empty string is not a member
      'GET_FILE_CONTENTS', // case-sensitive: not the same name
      'get_file_contents ', // trailing space: not the same name
      ' get_file_contents',
    ]
    for (const name of NOVEL) {
      expect(isReadOnlyTool(name)).toBe(false)
    }
  })

  it('is exact-match, not prefix/substring — never admits a longer or contained name', () => {
    // Guards against a sloppy future refactor that switched .has() for a .some(startsWith).
    expect(isReadOnlyTool('get_file_contents_unsafe')).toBe(false)
    expect(isReadOnlyTool('xget_file_contents')).toBe(false)
    expect(isReadOnlyTool('list_commits_and_delete')).toBe(false)
  })
})
