import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { initialSession } from '@akis/shared'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { recordGithubProposal } from '../../src/gates/recordGithubProposal.js'
import { proposeGithubWriteTool } from '../../src/agent/tools/proposeGithubWriteTool.js'
import { digestExternalWrite } from '../../src/gates/externalWriteGate.js'

/**
 * PHASE B unit tests for the agent-propose SIDE: the shared recorder (recordGithubProposal) and the
 * LLM-callable tool (proposeGithubWriteTool). The strict invariant under test: the tool/recorder can
 * ONLY append a status:'proposed' record — it hardcodes provider:'github', fail-closes on an off-list
 * action / a colliding target+payload, dedupes on the content digest, and (the REACHABILITY assertion)
 * holds NO reference to the gate's mint/execute/token — there is no code path from propose to execution.
 */

async function seededStore(id = 's1'): Promise<MockSessionStore> {
  const store = new MockSessionStore()
  await store.create({ ...initialSession(id, 'an idea', 'owner-1') })
  return store
}

const TARGET = { owner: 'OmerYasirOnal', repo: 'akis', issue_number: 42 }
const PAYLOAD = { body: 'AKIS finished — 7 real tests passed.' }

describe('recordGithubProposal (shared recorder)', () => {
  it('appends exactly one status:proposed record with provider HARDCODED to github', async () => {
    const store = await seededStore()
    const out = await recordGithubProposal(store, 's1', { action: 'add_issue_comment', summary: 'Comment on #42', target: TARGET, payload: PAYLOAD })
    expect('writeId' in out).toBe(true)
    const got = await store.get('s1')
    expect(got?.externalWrites).toHaveLength(1)
    const rec = got!.externalWrites![0]!
    expect(rec.provider).toBe('github') // HARDCODED — never a caller arg
    expect(rec.action).toBe('add_issue_comment')
    expect(rec.status).toBe('proposed')
    expect(rec.target).toEqual(TARGET)
    expect(rec.payload).toEqual(PAYLOAD)
    // The returned digest is the gate's own content digest over provider:'github' — what the human confirm binds.
    expect((out as { digest: string }).digest).toBe(digestExternalWrite({ provider: 'github', action: 'add_issue_comment', target: TARGET, payload: PAYLOAD }))
  })

  it('rejects an off-allow-list action with an error and appends NOTHING', async () => {
    const store = await seededStore()
    const out = await recordGithubProposal(store, 's1', { action: 'delete_repo', summary: 'nope', target: TARGET, payload: PAYLOAD })
    expect(out).toEqual({ error: expect.stringContaining('allow-list') })
    expect((await store.get('s1'))?.externalWrites ?? []).toHaveLength(0)
  })

  it('rejects a colliding target/payload (the disjoint-key invariant) and appends NOTHING', async () => {
    const store = await seededStore()
    // `body` appears in BOTH target and payload — the execute-merge would silently override.
    const out = await recordGithubProposal(store, 's1', {
      action: 'add_issue_comment', summary: 'x',
      target: { owner: 'o', repo: 'r', body: 'in-target' },
      payload: { body: 'in-payload' },
    })
    expect(out).toEqual({ error: expect.stringContaining('overlap') })
    expect((await store.get('s1'))?.externalWrites ?? []).toHaveLength(0)
  })

  it('dedupes on the content digest: a second identical record returns the same writeId, no second append', async () => {
    const store = await seededStore()
    const first = await recordGithubProposal(store, 's1', { action: 'add_issue_comment', summary: 'Comment on #42', target: TARGET, payload: PAYLOAD })
    const second = await recordGithubProposal(store, 's1', { action: 'add_issue_comment', summary: 'DIFFERENT summary (not part of the digest)', target: TARGET, payload: PAYLOAD })
    expect('writeId' in first && 'writeId' in second).toBe(true)
    expect((second as { writeId: string }).writeId).toBe((first as { writeId: string }).writeId)
    expect((await store.get('s1'))?.externalWrites).toHaveLength(1) // ONE card per content
  })

  it('a different content (changed payload) appends a SECOND distinct record', async () => {
    const store = await seededStore()
    await recordGithubProposal(store, 's1', { action: 'add_issue_comment', summary: 'a', target: TARGET, payload: PAYLOAD })
    await recordGithubProposal(store, 's1', { action: 'add_issue_comment', summary: 'b', target: TARGET, payload: { body: 'a different comment' } })
    expect((await store.get('s1'))?.externalWrites).toHaveLength(2)
  })

  it('a vanished session returns an error, never throws', async () => {
    const store = await seededStore()
    const out = await recordGithubProposal(store, 'ghost', { action: 'add_issue_comment', summary: 'x', target: TARGET, payload: PAYLOAD })
    expect(out).toEqual({ error: expect.stringContaining('ghost') })
  })
})

describe('proposeGithubWriteTool (LLM-callable handler)', () => {
  const tool = (store: MockSessionStore, sessionId = 's1') => proposeGithubWriteTool({ sessionId, store })

  it('advertises the propose_github_write spec with the GitHub action enum (sourced from the frozen set)', async () => {
    const store = await seededStore()
    const spec = tool(store).spec
    expect(spec.name).toBe('propose_github_write')
    const enumVals = (spec.schema as { properties: { action: { enum: string[] } } }).properties.action.enum
    expect(enumVals).toContain('issue_write')
    expect(enumVals).toContain('merge_pull_request')
    expect(enumVals).not.toContain('createPage') // an atlassian action must never appear in the github enum
  })

  it('handler appends a proposed record and returns the AWAITING-CONFIRMATION string (never claims it happened)', async () => {
    const store = await seededStore()
    const out = await tool(store).handler({ action: 'add_issue_comment', summary: 'Comment on #42', target: TARGET, payload: PAYLOAD })
    expect(out).toMatch(/^Proposed GitHub add_issue_comment \(writeId .+\)\. AWAITING HUMAN CONFIRMATION — not executed\./)
    expect(out).toMatch(/Do not assume it happened\./)
    const got = await store.get('s1')
    expect(got?.externalWrites).toHaveLength(1)
    expect(got!.externalWrites![0]!.status).toBe('proposed')
  })

  it('NEVER throws: an off-list action returns an Error string and appends nothing', async () => {
    const store = await seededStore()
    const out = await tool(store).handler({ action: 'delete_everything', summary: 'x', target: TARGET, payload: PAYLOAD })
    expect(out).toMatch(/^Error: /)
    expect(out).toContain('allow-list')
    expect((await store.get('s1'))?.externalWrites ?? []).toHaveLength(0)
  })

  it('NEVER throws on malformed args (missing/typed-wrong) — returns an Error string', async () => {
    const store = await seededStore()
    expect(await tool(store).handler({ action: 123, summary: 'x', target: {}, payload: {} })).toMatch(/^Error: 'action'/)
    expect(await tool(store).handler({ action: 'add_issue_comment', summary: '', target: {}, payload: {} })).toMatch(/^Error: 'summary'/)
    expect(await tool(store).handler({ action: 'add_issue_comment', summary: 'x', target: 'oops', payload: {} })).toMatch(/^Error: 'target'/)
    expect(await tool(store).handler({ action: 'add_issue_comment', summary: 'x', target: {}, payload: [1, 2] })).toMatch(/^Error: 'payload'/)
    expect(await tool(store).handler(null)).toMatch(/^Error: /)
    expect((await store.get('s1'))?.externalWrites ?? []).toHaveLength(0)
  })

  it('sessionId is CLOSED OVER, not a model arg — a model cannot retarget another session', async () => {
    const store = new MockSessionStore()
    await store.create({ ...initialSession('mine', 'idea', 'owner-1') })
    await store.create({ ...initialSession('other', 'idea', 'owner-2') })
    // The model "smuggles" a sessionId/provider in args — both are ignored (not in the schema/closure).
    await tool(store, 'mine').handler({ action: 'add_issue_comment', summary: 'x', target: TARGET, payload: PAYLOAD, sessionId: 'other', provider: 'atlassian' } as unknown)
    expect((await store.get('mine'))?.externalWrites).toHaveLength(1)
    expect((await store.get('other'))?.externalWrites ?? []).toHaveLength(0) // the other session is untouched
    expect((await store.get('mine'))!.externalWrites![0]!.provider).toBe('github') // not 'atlassian'
  })

  it('dedupes across loop turns: two identical handler calls ⇒ ONE record, same writeId reported', async () => {
    const store = await seededStore()
    const a = await tool(store).handler({ action: 'add_issue_comment', summary: 's', target: TARGET, payload: PAYLOAD })
    const b = await tool(store).handler({ action: 'add_issue_comment', summary: 's', target: TARGET, payload: PAYLOAD })
    const idOf = (s: string) => /writeId (\S+)\)/.exec(s)?.[1]
    expect(idOf(a)).toBe(idOf(b))
    expect((await store.get('s1'))?.externalWrites).toHaveLength(1)
  })
})

describe('REACHABILITY invariant (structural): propose tool cannot reach execution', () => {
  // The strongest the propose side may do is APPEND a status:'proposed' record. It must hold NO
  // reference to the minting function, the executor, or the branded approval token — so there is no
  // code path from the agent's tool to an external write. Assert this by scanning the module's IMPORT
  // statements (the surface it actually couples to); we ignore doc-comments, which legitimately NAME
  // these symbols to explain the invariant.
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8')
  /** Every `import … from …` statement in the file, comments stripped — the real coupling surface. */
  const importLines = (text: string): string =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')          // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1')        // line comments (not URL `://`)
      .split('\n')
      .filter(l => /^\s*import\b/.test(l))
      .join('\n')

  const FORBIDDEN = ['mintApprovedExternalWrite', 'executeExternalWrite', 'ApprovedExternalWrite']

  it('proposeGithubWriteTool.ts imports do NOT pull in mint/execute/the approval token', () => {
    const imports = importLines(src('agent/tools/proposeGithubWriteTool.ts'))
    for (const sym of FORBIDDEN) expect(imports).not.toContain(sym)
  })

  it('recordGithubProposal.ts (the shared recorder) imports do NOT pull in mint/execute/the approval token', () => {
    const imports = importLines(src('gates/recordGithubProposal.ts'))
    for (const sym of FORBIDDEN) expect(imports).not.toContain(sym)
  })
})
