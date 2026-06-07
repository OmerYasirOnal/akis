import { describe, it, expect, vi } from 'vitest'
import {
  digestExternalWrite, mintApprovedExternalWrite, executeExternalWrite,
  ExternalWriteDigestMismatchError, type ExternalWriteProposal,
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
