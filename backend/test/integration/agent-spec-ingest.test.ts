/**
 * Issue #168 (agent-output ingest): the APPROVED spec is auto-ingested as trusted RAG grounding
 * at the spec-approval boundary. End-to-end proof through the real RAG stack (embedding + vector
 * + BM25 + queue) driven by the orchestrator — NOT just that SpecSource.ingest was called.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function ragOrch(rag: boolean) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir, provider: new MockProvider(), mockCriticScore: 90,
    testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    ...(rag ? { rag: true } : {}),
  })
  return { orch: new Orchestrator(services), services }
}

const SPEC = {
  title: 'Zephyr Ledger',
  body: '# Zephyr Ledger\n\n## Scope\n- Track quantum flux entries in a ledger\n- Reconcile the flux balance nightly\n\n## Acceptance criteria\n- A new flux entry appears with the correct balance\n',
}

describe('agent-spec ingest (issue #168)', () => {
  it('a seeded-start (chat-approved spec) ingests the spec → it is retrievable via the RAG port', async () => {
    const { orch, services } = ragOrch(true)
    expect(services.specSource).toBeDefined() // wired only when RAG is on
    // A seeded start auto-satisfies Gate 1 (mintSpecApproval) → SpecSource.ingest fires.
    const s = await orch.start({ idea: 'a ledger app', spec: SPEC })
    await services.ragQueue?.drain() // the ingest is enqueued off the agent path — flush it
    // The distinctive spec text is now retrievable grounding for this session's tenancy.
    const hits = await services.knowledge.retrieve({ query: 'quantum flux ledger reconcile balance', sessionId: s.id, limit: 5 })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map(h => h.text).join('\n')).toMatch(/flux/i)
    // Provenance is the agent-spec source, never the raw userId.
    expect(hits.some(h => h.source.startsWith('agent-spec:'))).toBe(true)
  })

  it('the human approve() path ingests the spec too (both mint paths share mintSpecApproval)', async () => {
    const { orch, services } = ragOrch(true)
    // Start WITHOUT a seed → Scribe drafts, the run parks at awaiting_spec_approval, then approve.
    const s = await orch.start({ idea: 'a small notes app' })
    if ((await services.store.get(s.id))?.status === 'awaiting_spec_approval') await orch.approve(s.id)
    await services.ragQueue?.drain()
    // Whatever Scribe drafted for THIS session is now retrievable as agent-spec grounding.
    const hits = await services.knowledge.retrieve({ query: 'notes app spec scope acceptance', sessionId: s.id, limit: 5 })
    expect(hits.some(h => h.source.startsWith('agent-spec:'))).toBe(true)
  })

  it('RAG OFF (default): no specSource, approval is byte-identical (no ingest wiring)', async () => {
    const { orch, services } = ragOrch(false)
    expect(services.specSource).toBeUndefined()
    const s = await orch.start({ idea: 'a ledger app', spec: SPEC })
    expect((await services.store.get(s.id))?.status).toBe('building') // approval succeeded, unchanged
  })
})
