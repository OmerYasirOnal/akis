import { describe, it, expect, vi } from 'vitest'
import { Orchestrator, AlreadyPushedError } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { NotVerifiedError } from '../../src/gates/pushGate.js'
import { mintApprovedSpec } from '../../src/gates/specGate.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import type { LlmProvider, ChatRequest, ChatResult } from '../../src/agent/LlmProvider.js'
import type { RepoSource, RepoIngestInput } from '../../src/knowledge/ingest/RepoSource.js'
import { isVerified } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function makeOrch(opts: { mockCriticScore?: number; testsRun?: number; passed?: boolean } = {}) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: opts.mockCriticScore ?? 90,
    testRunner: createMockTestRunner({ testsRun: opts.testsRun ?? 2, passed: opts.passed ?? true }),
  })
  return { orch: new Orchestrator(services), services }
}

describe('Orchestrator — happy path', () => {
  it('start→approve→verify→confirm reaches done/verified', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    expect((await services.store.get(s.id))!.status).toBe('awaiting_spec_approval')
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const afterTrace = (await services.store.get(s.id))!
    expect(isVerified(afterTrace)).toBe(true)
    expect(afterTrace.status).toBe('awaiting_push_confirm')
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
  })
})

describe('Orchestrator — chat-approved spec seed (P0-1: single spec approval)', () => {
  it('a seed-started session opens already at building (spec-approved) with a minted ApprovedSpec and NO awaiting_spec_approval gate', async () => {
    const { orch, services } = makeOrch()
    const seed = { title: 'Minimal Todo', body: '# Minimal Todo\nAdd, list, complete todos.' }
    const s = await orch.start({ idea: seed.body, spec: seed })
    // The pipeline opens ALREADY at spec-approved (building), with NO second human click needed.
    // start()'s RETURN VALUE is the pre-kick snapshot; the auto-kicked run advances the STORE
    // concurrently, so stored.status is asserted via waitFor at the end, not read racily here.
    expect(s.status).toBe('building')
    const stored = (await services.store.get(s.id))!
    // The seeded spec is AUTHORITATIVE (used as-is, not re-authored by Scribe).
    expect(stored.spec).toEqual(seed)
    // Gate 1 is genuinely satisfied: a real branded ApprovalToken is persisted (still minted
    // server-side via the approvalAuthority — never a literal).
    expect(stored.approval).toBeDefined()
    expect(mintApprovedSpec(stored).spec).toEqual(seed)
    // The gate event is SATISFIED, never a second 'awaiting' spec-approval gate.
    const gates = services.bus.recent(s.id).filter(e => e.kind === 'gate' && (e as { gate: string }).gate === 'spec_approval')
    expect(gates.some(e => (e as { state: string }).state === 'awaiting')).toBe(false)
    expect(gates.some(e => (e as { state: string }).state === 'satisfied')).toBe(true)
    // Let the auto-kicked run settle so its async work never leaks into another test.
    await vi.waitFor(async () => expect((await services.store.get(s.id))!.status).toBe('awaiting_push_confirm'))
  })

  it('a seed-started session runs to verified+push with NO further call — start() ITSELF kicks the run (the SpecCard click is the single human action)', async () => {
    const { orch, services } = makeOrch()
    const seed = { title: 'Todo', body: '# Todo\nThe app.' }
    const s = await orch.start({ idea: seed.body, spec: seed })
    expect(s.status).toBe('building')
    // Deliberately NO runToVerification() here — this pins the server-side auto-kick.
    // Caught LIVE: without it nothing ever ran the pipeline (the FE's only api.run caller is
    // the legacy in-pipeline gate card a seeded start never shows) and every chat build
    // wedged at 'building' forever.
    await vi.waitFor(async () => expect((await services.store.get(s.id))!.status).toBe('awaiting_push_confirm'))
    const after = (await services.store.get(s.id))!
    expect(isVerified(after)).toBe(true)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
  })

  it('a seed-started session RECORDS Scribe\'s stage as done — exactly one scribe agent_start + agent_end — so the roster never shows Scribe idle, and the spec gate is still minted exactly once', async () => {
    const { orch, services } = makeOrch()
    const seed = { title: 'Minimal Todo', body: '# Minimal Todo\nAdd, list, complete todos.' }
    const s = await orch.start({ idea: seed.body, spec: seed })
    expect(s.status).toBe('building')
    // Let the auto-kicked run settle so this test's async work never leaks into another.
    await vi.waitFor(async () => expect((await services.store.get(s.id))!.status).toBe('awaiting_push_confirm'))
    const events = services.bus.recent(s.id)
    // BUG GUARD: on the chat-seeded path Scribe is short-circuited (its run() never executes), so
    // without a synthetic event the roster derives 'idle' ("beklemede") even though the spec WAS
    // authored. The seeded branch must record Scribe's stage with a real agent_start + agent_end.
    const scribeStarts = events.filter(e => e.kind === 'agent_start' && (e as { role: string }).role === 'scribe')
    const scribeEnds = events.filter(e => e.kind === 'agent_end' && (e as { role: string }).role === 'scribe')
    expect(scribeStarts).toHaveLength(1)
    expect(scribeEnds).toHaveLength(1)
    // The synthetic Scribe end is a SUCCESS (the spec is authored/approved).
    expect(scribeEnds[0]).toMatchObject({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId: 'main' })
    // GATE-SAFETY: the spec gate is still minted EXACTLY ONCE (one satisfied, never an awaiting).
    const gates = events.filter(e => e.kind === 'gate' && (e as { gate: string }).gate === 'spec_approval')
    expect(gates.filter(e => (e as { state: string }).state === 'satisfied')).toHaveLength(1)
    expect(gates.some(e => (e as { state: string }).state === 'awaiting')).toBe(false)
  })

  it('a second concurrent run is refused FAST (in-flight guard → WrongStatusError/409), never a double Proto run', async () => {
    const { orch } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    const first = orch.runToVerification(s.id)
    // The guard is set synchronously before the first await, so a concurrent second call is
    // rejected immediately — not minutes later on an optimistic-lock conflict after double
    // token spend.
    await expect(orch.runToVerification(s.id)).rejects.toThrow(/already in flight/)
    await expect(first).resolves.toMatchObject({ status: 'awaiting_push_confirm' })
  })

  it('REGRESSION (race fix): a spec-seeded start that ALSO seeds chat bakes the chat into the INITIAL state (set before kickRun) so no post-start write races the pipeline → the auto-run reaches awaiting_push_confirm, NOT failed', async () => {
    const { orch, services } = makeOrch()
    const seed = { title: 'Todo', body: '# Todo\nThe app.' }
    const chat = [{ role: 'user' as const, content: 'a todo app', at: new Date().toISOString() }]
    // start() returns the PRE-KICK snapshot. The fix bakes `chat` into the creation state (version 0)
    // BEFORE mintSpecApproval/kickRun, so the returned session ALREADY carries it — proving there is
    // NO post-start store.update racing the fire-and-forget pipeline. (The OLD code seeded chat AFTER
    // start via store.update(id,{chat},version); that write, landing between the pipeline's version
    // read and its {code} write, bumped the version → a `version conflict` → the build went `failed`
    // with no code. Here the chat is part of the single creation write, so that window cannot exist.)
    const s = await orch.start({ idea: seed.body, spec: seed, chat })
    // ATOMIC SEED: present immediately, before any pipeline write could have run.
    expect(s.chat).toEqual(chat)
    expect(s.status).toBe('building')
    const justCreated = (await services.store.get(s.id))!
    expect(justCreated.chat).toEqual(chat)
    // The auto-kicked seeded run completes to the push gate — it is NOT driven to `failed` by a
    // concurrent chat write (the race). isVerified holds, so the pipeline genuinely produced code.
    await vi.waitFor(async () => expect((await services.store.get(s.id))!.status).toBe('awaiting_push_confirm'))
    const after = (await services.store.get(s.id))!
    expect(after.status).not.toBe('failed')
    expect(after.chat).toEqual(chat) // the seed survived the whole pipeline (never clobbered/lost)
    expect(isVerified(after)).toBe(true)
  })

  it('absent chat seed is byte-identical: a seeded start with NO chat carries no chat field', async () => {
    const { orch } = makeOrch()
    const seed = { title: 'Todo', body: '# Todo\nThe app.' }
    const s = await orch.start({ idea: seed.body, spec: seed })
    expect(s.chat).toBeUndefined()
  })

  it('an idea-only start is UNCHANGED: Scribe runs and the awaiting_spec_approval gate still emits', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    // No seed → today's path: parked at the human spec gate, no approval minted yet.
    expect(s.status).toBe('awaiting_spec_approval')
    expect((await services.store.get(s.id))!.approval).toBeUndefined()
    const gates = services.bus.recent(s.id).filter(e => e.kind === 'gate' && (e as { gate: string }).gate === 'spec_approval')
    expect(gates.some(e => (e as { state: string }).state === 'awaiting')).toBe(true)
    expect(gates.some(e => (e as { state: string }).state === 'satisfied')).toBe(false)
  })
})

describe('Orchestrator — code-review visibility', () => {
  it('emits a structured code_review event (approved verdict) at the review step', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const events = services.bus.recent(s.id)
    const cr = events.find(e => e.kind === 'code_review')
    expect(cr).toBeDefined()
    expect(cr).toMatchObject({ kind: 'code_review', approved: true, critical: false, agent: 'critic', laneId: 'main' })
    // Structured-only: findings/iteration are bounded numbers, never free-form prose.
    expect(typeof (cr as { findings: unknown }).findings).toBe('number')
    expect(typeof (cr as { iteration: unknown }).iteration).toBe('number')
    // It is NOT a text event, so the RAG ingestion sink never treats it as trusted grounding.
    expect(cr).not.toHaveProperty('text')
  })
})

describe('Orchestrator — vacuous green (0 tests)', () => {
  it('does not verify and cannot confirm push', async () => {
    const { orch, services } = makeOrch({ testsRun: 0 })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const st = (await services.store.get(s.id))!
    expect(isVerified(st)).toBe(false)
    expect(st.status).not.toBe('awaiting_push_confirm')
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(Error)
  })
})

describe('Orchestrator — tests ran but failed', () => {
  it('does not verify (passed=false with testsRun>=1)', async () => {
    const { orch, services } = makeOrch({ testsRun: 3, passed: false })
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    expect(isVerified((await services.store.get(s.id))!)).toBe(false)
  })
})

describe('Orchestrator — critic hard-block', () => {
  it('critical finding → awaiting_critic_resolution, never verified', async () => {
    const { orch, services } = makeOrch({ mockCriticScore: 40 })
    const s = await orch.start({ idea: 'todo' })
    // start() already parks at awaiting_critic_resolution because the spec review failed.
    expect((await services.store.get(s.id))!.status).toBe('awaiting_critic_resolution')
    // approve is refused from that status.
    await expect(orch.approve(s.id)).rejects.toBeInstanceOf(Error)
    expect(isVerified((await services.store.get(s.id))!)).toBe(false)
  })
})

describe('Orchestrator — confirmPush is idempotent', () => {
  it('a second confirmPush throws and does not re-push', async () => {
    const { orch, services } = makeOrch()
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    await orch.confirmPush(s.id)
    const filesAfterFirst = services.github.read(s.id).length
    await expect(orch.confirmPush(s.id)).rejects.toBeInstanceOf(AlreadyPushedError)
    expect(services.github.read(s.id).length).toBe(filesAfterFirst)
  })
})

describe('Orchestrator — verified survives a fresh instance (no in-memory token)', () => {
  it('a second Orchestrator over the same store can push the verified session', async () => {
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const orch1 = new Orchestrator(services)
    const s = await orch1.start({ idea: 'todo' })
    await orch1.approve(s.id)
    await orch1.runToVerification(s.id)
    // A different Orchestrator instance (simulating restart) sharing the store + github.
    const orch2 = new Orchestrator(services)
    const done = await orch2.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
  })
})

describe('Orchestrator — repo auto-ingest on push (issue #7 AC1)', () => {
  // A repoSource + ragUserIdFor are present ONLY when RAG is on. Drive a verified
  // session to done and assert the push triggers an automatic ingest of the pushed repo.
  function makeRagOrch(repoSource: Pick<RepoSource, 'ingest'>) {
    const store = new MockSessionStore()
    const services = buildServices({
      store, skillsDir,
      mockCriticScore: 90,
      testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    })
    // Simulate RAG-on wiring: surface a repoSource + tenancy resolver on the services.
    const ragServices = {
      ...services,
      repoSource: repoSource as RepoSource,
      ragUserIdFor: (_sessionId: string) => 'local',
    }
    return { orch: new Orchestrator(ragServices), services: ragServices }
  }

  it('confirmPush triggers repoSource.ingest with {sessionId,userId} after a successful push', async () => {
    const calls: RepoIngestInput[] = []
    const repoSource = { ingest: async (input: RepoIngestInput): Promise<void> => { calls.push(input) } }
    const { orch } = makeRagOrch(repoSource)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(calls).toEqual([{ sessionId: s.id, userId: 'local' }])
  })

  it('a THROWING repoSource.ingest does NOT fail confirmPush and the session still reaches done', async () => {
    let attempted = false
    const repoSource = { ingest: async (): Promise<void> => { attempted = true; throw new Error('ingest blew up') } }
    const { orch, services } = makeRagOrch(repoSource)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(attempted).toBe(true) // ingest WAS attempted (not vacuously skipped)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
    // The session status persisted is still 'done' — the failed ingest never mutated it.
    expect((await services.store.get(s.id))!.status).toBe('done')
  })
})

describe('Orchestrator — Scribe docs ship with the app (digest-bound, Gate 4)', () => {
  it('a Scribe-authored README.md lands in the VERIFIED code.files and survives the push-gate digest re-check', async () => {
    // A provider that returns a README for the writeDocs pass and delegates everything else
    // (spec/code) to the deterministic MockProvider.
    const mock = new MockProvider()
    const provider: LlmProvider = {
      name: 'mock', model: 'mock',
      async chat(req: ChatRequest): Promise<ChatResult> {
        if (typeof req.system === 'string' && req.system.includes('writing the README')) {
          return { text: '# Built App\n\nThis app does what the spec describes. Run it locally with the included files.' }
        }
        return mock.chat(req)
      },
    }
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, provider, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const verified = (await services.store.get(s.id))!
    expect(isVerified(verified)).toBe(true)
    // The README is in the VERIFIED file set (digest-bound into the VerifyToken).
    const readme = verified.code?.files.find(f => f.filePath === 'README.md')
    expect(readme).toBeDefined()
    expect(readme?.content).toContain('Built App')
    // The push gate re-check (digestFiles(files) === verifyToken.codeDigest) passes WITH the README
    // present → it ships through the same Gate 4 → done. (A digest mismatch would throw here.)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
  })
})

void NotVerifiedError
