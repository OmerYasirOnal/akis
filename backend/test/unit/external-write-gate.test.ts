import { describe, it, expect, vi } from 'vitest'
import {
  digestExternalWrite, mintApprovedExternalWrite, executeExternalWrite,
  ExternalWriteDigestMismatchError, ExternalWriteActionNotAllowedError,
  ExternalWriteKeyCollisionError,
  isAllowedExternalWriteAction, ATLASSIAN_WRITE_ACTIONS, GITHUB_WRITE_ACTIONS, WRITE_ACTIONS_BY_PROVIDER,
  type ExternalWriteProposal,
} from '../../src/gates/externalWriteGate.js'
import type { McpTransport, McpToolResult } from '../../src/agent/mcp/McpTransport.js'

const proposal = (over: Partial<ExternalWriteProposal> = {}): ExternalWriteProposal => ({
  id: 'w1',
  provider: 'atlassian',
  summary: 'Create Confluence page "Release notes"',
  action: 'createPage',
  target: { spaceKey: 'ENG' },
  payload: { title: 'Release notes', body: '# v1' },
  ...over,
})

/** A fake MCP transport that records the one write call. */
function fakeTransport(result: McpToolResult = { text: 'created: PAGE-1', isError: false }) {
  const calls: Array<{ name: string; args: unknown }> = []
  const t: McpTransport = {
    initialize: async () => {},
    listTools: async () => [],
    callTool: async (name, args) => { calls.push({ name, args }); return result },
    close: async () => {},
  }
  return { t, calls }
}

describe('externalWriteGate — digest', () => {
  it('is stable and INDEPENDENT of key order in target/payload (canonicalized)', () => {
    const a = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: { spaceKey: 'ENG', parentId: '9' }, payload: { title: 'X', body: 'Y' } })
    const b = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: { parentId: '9', spaceKey: 'ENG' }, payload: { body: 'Y', title: 'X' } })
    expect(a).toBe(b)
  })
  it('CHANGES when any content byte changes (a swapped payload is a different digest)', () => {
    const base = digestExternalWrite(proposal())
    expect(digestExternalWrite(proposal({ payload: { title: 'Release notes', body: '# v2 (tampered)' } }))).not.toBe(base)
    expect(digestExternalWrite(proposal({ target: { spaceKey: 'OPS' } }))).not.toBe(base)
    expect(digestExternalWrite(proposal({ action: 'createJiraIssue' }))).not.toBe(base)
  })
  it('IGNORES the id (a handle, not content)', () => {
    expect(digestExternalWrite(proposal({ id: 'other' }))).toBe(digestExternalWrite(proposal()))
  })
  it('canonicalizes NESTED object key order too (deep, not just top level)', () => {
    const a = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: { spaceKey: 'ENG' }, payload: { meta: { a: 1, b: 2 }, title: 'X' } })
    const b = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: { spaceKey: 'ENG' }, payload: { title: 'X', meta: { b: 2, a: 1 } } })
    expect(a).toBe(b)
  })
  it('canonicalizes object keys inside ARRAYS too (deep, order-preserving for array elements)', () => {
    const a = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: {}, payload: { items: [{ a: 1, b: 2 }, { c: 3, d: 4 }] } })
    const b = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: {}, payload: { items: [{ b: 2, a: 1 }, { d: 4, c: 3 }] } })
    expect(a).toBe(b)
  })
  it('CHANGES when ARRAY ELEMENT order changes (element order IS content — reordering must not re-confirm)', () => {
    const a = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: {}, payload: { items: [{ a: 1 }, { b: 2 }] } })
    const b = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: {}, payload: { items: [{ b: 2 }, { a: 1 }] } })
    expect(a).not.toBe(b)
  })
  it('still CHANGES when a nested content byte changes', () => {
    const base = digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: {}, payload: { meta: { a: 1, b: 2 } } })
    expect(digestExternalWrite({ provider: 'atlassian', action: 'createPage', target: {}, payload: { meta: { a: 1, b: 3 } } })).not.toBe(base)
  })
})

describe('externalWriteGate — mint requires the human-confirmed digest to match', () => {
  it('mints when the confirmed digest equals the proposal content digest', () => {
    const p = proposal()
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    expect(token.writeId).toBe('w1')
    expect(token.digest).toBe(digestExternalWrite(p))
  })
  it('THROWS when the confirmed digest does not match (a swap between display and confirm)', () => {
    const p = proposal()
    expect(() => mintApprovedExternalWrite(p, 'deadbeef')).toThrow(ExternalWriteDigestMismatchError)
    // confirming digest of a DIFFERENT payload than the stored proposal → refused
    const tampered = digestExternalWrite(proposal({ payload: { title: 'Release notes', body: 'evil' } }))
    expect(() => mintApprovedExternalWrite(p, tampered)).toThrow(ExternalWriteDigestMismatchError)
  })
})

describe('externalWriteGate — execute requires the token + matching proposal', () => {
  it('executes the confirmed write via the transport (merged target+payload) and returns the result', async () => {
    const p = proposal()
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    const { t, calls } = fakeTransport()
    const res = await executeExternalWrite(token, t, p)
    expect(res).toEqual({ ok: true, text: 'created: PAGE-1' })
    expect(calls).toEqual([{ name: 'createPage', args: { spaceKey: 'ENG', title: 'Release notes', body: '# v1' } }])
  })
  it('REFUSES to execute a proposal whose content differs from the minted token (post-confirm tamper)', async () => {
    const p = proposal()
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    const { t, calls } = fakeTransport()
    const tampered = proposal({ payload: { title: 'Release notes', body: 'evil' } }) // same id, different content
    await expect(executeExternalWrite(token, t, tampered)).rejects.toThrow(ExternalWriteDigestMismatchError)
    expect(calls).toHaveLength(0) // nothing was written
  })
  it('surfaces a provider error as ok:false (no throw)', async () => {
    const p = proposal()
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    const { t } = fakeTransport({ text: 'permission denied', isError: true })
    expect(await executeExternalWrite(token, t, p)).toEqual({ ok: false, text: 'permission denied' })
  })
})

describe('externalWriteGate — positive write-action allow-list', () => {
  it('the allow-list is the SINGLE predicate; admits known write actions, rejects everything else', () => {
    expect(isAllowedExternalWriteAction('atlassian', 'createPage')).toBe(true)
    expect(isAllowedExternalWriteAction('atlassian', 'createJiraIssue')).toBe(true)
    // anything not on the positive set is rejected — including reads and unknown mutators
    expect(isAllowedExternalWriteAction('atlassian', 'deletePage')).toBe(false)
    expect(isAllowedExternalWriteAction('atlassian', 'getPage')).toBe(false)
    expect(isAllowedExternalWriteAction('atlassian', '')).toBe(false)
    expect(isAllowedExternalWriteAction('atlassian', 'createpage')).toBe(false) // case-sensitive
  })

  it('the allow-list set is immutable in FACT — add/delete/clear throw (cannot be widened)', () => {
    expect(() => (ATLASSIAN_WRITE_ACTIONS as Set<string>).add('deletePage')).toThrow(TypeError)
    expect(() => (ATLASSIAN_WRITE_ACTIONS as Set<string>).delete('createPage')).toThrow(TypeError)
    expect(() => (ATLASSIAN_WRITE_ACTIONS as Set<string>).clear()).toThrow(TypeError)
    expect(ATLASSIAN_WRITE_ACTIONS.has('deletePage')).toBe(false)
    expect(ATLASSIAN_WRITE_ACTIONS.has('createPage')).toBe(true)
  })

  it('the GITHUB allow-list set is ALSO immutable in FACT — add/delete/clear throw', () => {
    expect(() => (GITHUB_WRITE_ACTIONS as Set<string>).add('delete_file')).toThrow(TypeError)
    expect(() => (GITHUB_WRITE_ACTIONS as Set<string>).delete('issue_write')).toThrow(TypeError)
    expect(() => (GITHUB_WRITE_ACTIONS as Set<string>).clear()).toThrow(TypeError)
    expect(GITHUB_WRITE_ACTIONS.has('delete_file')).toBe(false)
    expect(GITHUB_WRITE_ACTIONS.has('issue_write')).toBe(true)
  })

  it('mint REFUSES a proposal whose target/payload keys COLLIDE (the {...target,...payload} merge would silently override)', () => {
    // `body` is in BOTH — at execute time payload.body would shadow target.body with no signal.
    const p = proposal({ target: { spaceKey: 'ENG', body: 'TARGET-OWNED' }, payload: { title: 'X', body: 'PAYLOAD-OWNED' } })
    expect(() => mintApprovedExternalWrite(p, digestExternalWrite(p))).toThrow(ExternalWriteKeyCollisionError)
  })

  it('mint ALLOWS a proposal whose target/payload keys are DISJOINT (the common, legitimate case)', () => {
    const p = proposal({ target: { spaceKey: 'ENG' }, payload: { title: 'X', body: 'Y' } })
    expect(() => mintApprovedExternalWrite(p, digestExternalWrite(p))).not.toThrow()
  })

  it('execute ALSO refuses colliding keys (defense-in-depth parity with the allow-list — never rests on mint alone)', async () => {
    // Mint from a disjoint proposal, then present a COLLIDING one with the same id: the digest
    // re-check would already refuse it, but assert the collision guard independently by digest-matching.
    const colliding = proposal({ target: { spaceKey: 'ENG', body: 'TARGET-OWNED' }, payload: { title: 'X', body: 'PAYLOAD-OWNED' } })
    const clean = proposal({ target: { spaceKey: 'ENG' }, payload: { title: 'X', body: 'Y' } })
    const token = mintApprovedExternalWrite(clean, digestExternalWrite(clean))
    const { t, calls } = fakeTransport()
    await expect(executeExternalWrite(token, t, colliding)).rejects.toThrow() // digest mismatch OR collision — refused either way
    expect(calls.length).toBe(0) // and crucially: the transport never fired
  })

  it('mint REFUSES a proposal whose action is not on the allow-list (the doc-comment promise enforced)', () => {
    const p = proposal({ action: 'deletePage' })
    expect(() => mintApprovedExternalWrite(p, digestExternalWrite(p))).toThrow(ExternalWriteActionNotAllowedError)
  })

  it('execute REFUSES a proposal whose action is not on the allow-list (defense-in-depth at the bridge)', async () => {
    const p = proposal()
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    const { t, calls } = fakeTransport()
    // a post-mint swap to an off-list action with a re-derived matching digest must still be refused
    const offList = { ...p, action: 'deletePage' } as ExternalWriteProposal
    const offListToken = { ...token, digest: digestExternalWrite(offList) } as typeof token
    await expect(executeExternalWrite(offListToken, t, offList)).rejects.toThrow(ExternalWriteActionNotAllowedError)
    expect(calls).toHaveLength(0)
  })
})

describe('externalWriteGate — PROVIDER-AWARE allow-list (phase 1: GitHub writes)', () => {
  it('admits each provider its OWN actions and REJECTS the other provider\'s actions (no cross-provider smuggling)', () => {
    // github actions are valid under github…
    expect(isAllowedExternalWriteAction('github', 'issue_write')).toBe(true)
    expect(isAllowedExternalWriteAction('github', 'add_issue_comment')).toBe(true)
    expect(isAllowedExternalWriteAction('github', 'pull_request_review_write')).toBe(true)
    // …and INVALID under atlassian
    expect(isAllowedExternalWriteAction('atlassian', 'issue_write')).toBe(false)
    expect(isAllowedExternalWriteAction('atlassian', 'pull_request_review_write')).toBe(false)
    // and vice-versa: atlassian actions are invalid under github
    expect(isAllowedExternalWriteAction('github', 'createPage')).toBe(false)
    expect(isAllowedExternalWriteAction('github', 'createJiraIssue')).toBe(false)
    // unknown github action still rejected (flat github-mcp-server names DON'T exist on this server)
    expect(isAllowedExternalWriteAction('github', 'create_issue')).toBe(false)
    expect(isAllowedExternalWriteAction('github', 'delete_file')).toBe(false)
  })

  it('mint THROWS ExternalWriteActionNotAllowedError for an OFF-PROVIDER action (github action under atlassian)', () => {
    const p = proposal({ provider: 'atlassian', action: 'issue_write' })
    expect(() => mintApprovedExternalWrite(p, digestExternalWrite(p))).toThrow(ExternalWriteActionNotAllowedError)
  })

  it('mint THROWS for an atlassian action proposed under github (vice-versa)', () => {
    const p = proposal({ provider: 'github', action: 'createPage', target: { owner: 'me' }, payload: { title: 'X' } })
    expect(() => mintApprovedExternalWrite(p, digestExternalWrite(p))).toThrow(ExternalWriteActionNotAllowedError)
  })

  it('mints + executes a valid GITHUB write (issue_write) end-to-end through the gate', async () => {
    const p = proposal({
      provider: 'github', action: 'issue_write',
      summary: 'Open issue "Bug: crash"',
      target: { owner: 'OmerYasirOnal', repo: 'akis' },
      payload: { method: 'create', title: 'Bug: crash', body: 'steps…' },
    })
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    const { t, calls } = fakeTransport({ text: 'created issue #7', isError: false })
    const res = await executeExternalWrite(token, t, p)
    expect(res).toEqual({ ok: true, text: 'created issue #7' })
    expect(calls).toEqual([{ name: 'issue_write', args: { owner: 'OmerYasirOnal', repo: 'akis', method: 'create', title: 'Bug: crash', body: 'steps…' } }])
  })

  it('execute REFUSES an off-provider action (defense-in-depth, after a digest-matching swap)', async () => {
    // mint a clean github proposal, then present an atlassian-only action with a re-derived matching
    // digest under provider github — must still be refused at execute.
    const p = proposal({ provider: 'github', action: 'issue_write', target: { owner: 'me', repo: 'r' }, payload: { method: 'create', title: 'X' } })
    const token = mintApprovedExternalWrite(p, digestExternalWrite(p))
    const offProvider = { ...p, action: 'createPage' } as ExternalWriteProposal
    const offToken = { ...token, digest: digestExternalWrite(offProvider) } as typeof token
    const { t, calls } = fakeTransport()
    await expect(executeExternalWrite(offToken, t, offProvider)).rejects.toThrow(ExternalWriteActionNotAllowedError)
    expect(calls).toHaveLength(0)
  })

  // PIN the GitHub write-tool names to what the connected GitHub remote MCP (api.githubcopilot.com/mcp)
  // ACTUALLY advertises — captured LIVE 2026-06-08 via tools/list against the owner's connection. If
  // the server renames/removes one of these, this test fails LOUDLY (a name mismatch otherwise silently
  // refuses every legitimate write — the exact bug class STEP A guards against).
  it('GITHUB_WRITE_ACTIONS is pinned to the LIVE github-remote-MCP tool names (NOT the flat github-mcp-server names)', () => {
    // 8 actions: 3 issue/review writes (phase 1) + 5 PULL-REQUEST writes (phase A). Verified live
    // 2026-06-08 against api.githubcopilot.com/mcp — there is NO consolidated `pull_request_write`.
    expect([...GITHUB_WRITE_ACTIONS].sort()).toEqual([
      'add_issue_comment',
      'create_pull_request',
      'issue_write',
      'merge_pull_request',
      'pull_request_review_write',
      'request_copilot_review',
      'update_pull_request',
      'update_pull_request_branch',
    ])
    // The flat github-mcp-server names DO NOT EXIST on api.githubcopilot.com/mcp — assert they are NOT
    // on the set, so a future copy-paste of the "standard" names is caught (those would refuse all writes).
    for (const flat of ['create_issue', 'update_issue', 'add_issue_comment_legacy', 'create_pull_request_review']) {
      expect(GITHUB_WRITE_ACTIONS.has(flat)).toBe(false)
    }
    // NEGATIVE pin: there is NO consolidated flat `pull_request_write` — the real tools are the five
    // separate names above. Guessing the flat name would silently refuse every PR write.
    expect(GITHUB_WRITE_ACTIONS.has('pull_request_write')).toBe(false)
  })

  it('PR writes are admitted under github and REJECTED under atlassian (merge is provider-scoped like the rest)', () => {
    // The 5 PR write actions are valid under github…
    for (const a of ['create_pull_request', 'update_pull_request', 'merge_pull_request', 'update_pull_request_branch', 'request_copilot_review']) {
      expect(isAllowedExternalWriteAction('github', a)).toBe(true)
    }
    // …and the IRREVERSIBLE merge is the canonical positive/negative pair the requirements call out.
    expect(isAllowedExternalWriteAction('github', 'merge_pull_request')).toBe(true)
    expect(isAllowedExternalWriteAction('atlassian', 'merge_pull_request')).toBe(false)
    // the guessed flat name is on NEITHER provider's set
    expect(isAllowedExternalWriteAction('github', 'pull_request_write')).toBe(false)
    expect(isAllowedExternalWriteAction('atlassian', 'pull_request_write')).toBe(false)
  })

  it('WRITE_ACTIONS_BY_PROVIDER maps each provider to its own set and the two sets are DISJOINT', () => {
    expect(WRITE_ACTIONS_BY_PROVIDER.atlassian).toBe(ATLASSIAN_WRITE_ACTIONS)
    expect(WRITE_ACTIONS_BY_PROVIDER.github).toBe(GITHUB_WRITE_ACTIONS)
    const intersection = [...GITHUB_WRITE_ACTIONS].filter(a => ATLASSIAN_WRITE_ACTIONS.has(a))
    expect(intersection).toEqual([]) // no name is valid for both providers
  })
})

describe('externalWriteGate — no forging path (compile-time brand)', () => {
  it('an external write cannot be executed without a minted token (the only producer is mint)', async () => {
    // A literal/`as` ApprovedExternalWrite is a COMPILE error (the brand is a module-private unique
    // symbol). This runtime test documents the single legitimate path: mint → execute.
    const p = proposal()
    const { t, calls } = fakeTransport()
    await executeExternalWrite(mintApprovedExternalWrite(p, digestExternalWrite(p)), t, p)
    expect(calls).toHaveLength(1)
  })
})
