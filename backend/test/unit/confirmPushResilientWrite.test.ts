/**
 * P0-1 — confirmPush terminal writes survive a CONCURRENT version bump.
 *
 * A REAL GitHub push (createRepo + N blob/tree/commit/ref/PR round-trips) takes 5-15s. Before this
 * fix, confirmPush read `cur` ONCE near its top and locked all THREE terminal writes (mock-refusal
 * park, push-failure park, success 'done') to that SAME stale `cur.version`. Any concurrent session
 * write in the push window (a chat turn via chatAppend, etc.) bumps the version → the terminal write
 * threw `version conflict` → the user saw a raw 500 AFTER GitHub already received the code, and the
 * session stranded at awaiting_push_confirm (a retry then hit AlreadyPushedError confusion).
 *
 * These tests simulate that race by bumping the persisted version WHILE the adapter's push is in
 * flight (the spy's pushFiles awaits a deferred we resolve only after the bump), then assert the
 * terminal write still lands through the established `updateResilient` re-read-fresh-version loop.
 * No assertion here is loosened relative to the existing confirmPush suite — these are additive.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import type { GitHubAdapter, RepoFile } from '../../src/di/MockGitHubAdapter.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

/** A manually-resolvable promise — lets a test hold pushFiles "in flight". */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let res!: () => void
  let rej!: (e: unknown) => void
  const promise = new Promise<void>((r, j) => { res = r; rej = j })
  return { promise, resolve: res, reject: rej }
}

/**
 * A spy adapter whose pushFiles BLOCKS on a gate the test controls. `started` resolves once
 * createRepo+pushFiles has been entered (so the test knows the push window is open), then the
 * test bumps the session version and finally releases `gate` to let the push complete (or throw).
 */
function blockingAdapter(gate: Promise<void>): GitHubAdapter & { started: Promise<void>; pushed: boolean } {
  let markStarted!: () => void
  const started = new Promise<void>(r => { markStarted = r })
  const a = {
    started,
    pushed: false,
    async createRepo(_id: string): Promise<string> { return 'https://github.com/spy/repo' },
    async pushFiles(_id: string, _files: RepoFile[]): Promise<void> {
      markStarted()      // signal the push window is open
      await gate          // hold here until the test releases (after it bumps the version)
      a.pushed = true
    },
    read(_id: string): RepoFile[] { return [] },
  }
  return a
}

/** Drive a fresh session to awaiting_push_confirm (verified) with the given push adapter. */
async function verifiedSessionWith(adapter: GitHubAdapter): Promise<{ orch: Orchestrator; store: MockSessionStore; id: string; servicesBus: ReturnType<typeof buildServices>['bus'] }> {
  const store = new MockSessionStore()
  const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
  services.github = adapter
  // No githubFor → NOT real-mode for an owned session, so the spy adapter is the legitimate
  // destination and the mock-refusal honesty branch never fires (we want the push path).
  const orch = new Orchestrator(services)
  const s = await orch.start({ idea: 'todo app', ownerId: 'owner-1' })
  await orch.approve(s.id)
  const after = await orch.runToVerification(s.id)
  expect(after.status).toBe('awaiting_push_confirm')
  return { orch, store, id: s.id, servicesBus: services.bus }
}

/** Simulate a concurrent chat-turn-style write: bump the version with a pure non-gate field. */
async function bumpVersion(store: MockSessionStore, id: string): Promise<void> {
  const fresh = await store.get(id)
  if (!fresh) throw new Error('session vanished')
  // `idea` is a plain SessionPatch column (stand-in for a chatAppend/transcript write) — it bumps
  // the persisted version exactly like a live chat turn would, WITHOUT touching any gate column.
  await store.update(id, { idea: `${fresh.idea} (edited mid-push)` }, fresh.version)
}

describe('confirmPush — resilient terminal writes (P0-1)', () => {
  it('SUCCESS path: lands done despite a concurrent version bump while the push is in flight', async () => {
    const gate = deferred()
    const adapter = blockingAdapter(gate.promise)
    const { orch, store, id, servicesBus } = await verifiedSessionWith(adapter)

    const versionBefore = (await store.get(id))!.version
    const confirmP = orch.confirmPush(id)
    // Wait until the push window is genuinely open (pushFiles entered, blocked on the gate)…
    await adapter.started
    // …then race a concurrent write that bumps the persisted version under confirmPush's feet.
    await bumpVersion(store, id)
    expect((await store.get(id))!.version).toBeGreaterThan(versionBefore)
    // Release the push so the terminal 'done' write fires AGAINST a now-stale captured version.
    gate.resolve()

    const done = await confirmP // before the fix this threw `version conflict` (raw 500)
    expect(done.status).toBe('done')
    expect(adapter.pushed).toBe(true)
    // Gate-4 satisfaction emitted exactly once (mint/emit order untouched).
    const satisfied = servicesBus.recent(id).filter(e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'satisfied')
    expect(satisfied).toHaveLength(1)
    // The session is persisted terminal 'done', and the concurrent edit was NOT clobbered.
    const persisted = await store.get(id)
    expect(persisted?.status).toBe('done')
    expect(persisted?.idea).toContain('(edited mid-push)')
  })

  it('SUCCESS path: persists a just-derived delivery despite a concurrent bump', async () => {
    const gate = deferred()
    const adapter = blockingAdapter(gate.promise)
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, mockCriticScore: 90, testRunner: createMockTestRunner({ testsRun: 2, passed: true }) })
    services.github = adapter
    // Real-mode wiring: a per-user resolver that NAMES a destination AND a per-user adapter (the spy),
    // so confirmPush folds a freshly-resolved `delivery` into the terminal write — the column that
    // must survive the resilient re-write.
    services.githubFor = (_ownerId: string) => adapter
    services.deliveryFor = async () => ({ owner: 'owner-1', repo: 'todo-app' })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'todo app', ownerId: 'owner-1' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)

    const confirmP = orch.confirmPush(s.id)
    await adapter.started
    await bumpVersion(store, s.id)
    gate.resolve()

    const done = await confirmP
    expect(done.status).toBe('done')
    expect(done.delivery).toEqual({ owner: 'owner-1', repo: 'todo-app' })
    expect((await store.get(s.id))?.delivery).toEqual({ owner: 'owner-1', repo: 'todo-app' })
  })

  it('FAILURE park: lands push_failed despite a concurrent bump when the push throws', async () => {
    const gate = deferred()
    const adapter = blockingAdapter(gate.promise)
    const { orch, store, id, servicesBus } = await verifiedSessionWith(adapter)

    const confirmP = orch.confirmPush(id)
    await adapter.started
    await bumpVersion(store, id) // concurrent write bumps the version mid-push…
    gate.reject(new Error('boom: simulated push transport failure')) // …then the push fails

    // The catch-path park must STILL land (no version-conflict throw masking the real error) AND
    // rethrow the ORIGINAL push error.
    await expect(confirmP).rejects.toThrow(/boom: simulated push transport failure/)
    const persisted = await store.get(id)
    expect(persisted?.status).toBe('push_failed') // parked retryable, not stranded at awaiting_push_confirm
    expect(persisted?.idea).toContain('(edited mid-push)') // concurrent edit preserved
    // Recovery (awaiting) emitted so the FE can offer "Push failed — retry"; gate NOT satisfied.
    expect(servicesBus.recent(id).some(e => e.kind === 'recovery' && e.recovery === 'push_failed' && e.state === 'awaiting')).toBe(true)
    expect(servicesBus.recent(id).some(e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'satisfied')).toBe(false)
  })

  it('FAILURE park: a concurrent CANCEL mid-push never masks the original push error and still shows the recovery card', async () => {
    // reviewer LOW: the catch-path park write itself can throw — here a genuine concurrent cancel makes
    // updateResilient refuse (RunCancelledError) rather than resurrect a park over 'cancelled'. The
    // ORIGINAL push error must remain authoritative (not masked by the write's throw), and the recovery
    // emit must already have fired (it precedes the park write), so the FE still renders "Push failed".
    const gate = deferred()
    const adapter = blockingAdapter(gate.promise)
    const { orch, store, id, servicesBus } = await verifiedSessionWith(adapter)

    const confirmP = orch.confirmPush(id)
    await adapter.started
    // awaiting_push_confirm is deliberately cancellable mid-push — flip the row to 'cancelled' now.
    await orch.cancel(id)
    expect((await store.get(id))?.status).toBe('cancelled')
    gate.reject(new Error('boom: push died after the user cancelled')) // then the in-flight push fails

    // The caller sees the ORIGINAL push error — NOT a RunCancelledError leaked from the park write.
    await expect(confirmP).rejects.toThrow(/boom: push died after the user cancelled/)
    // The cancel is honored: the row stays 'cancelled' (the park did NOT resurrect it to push_failed).
    expect((await store.get(id))?.status).toBe('cancelled')
    // The recovery card was emitted BEFORE the (throwing) park write, so the FE still surfaces it.
    expect(servicesBus.recent(id).some(e => e.kind === 'recovery' && e.recovery === 'push_failed' && e.state === 'awaiting')).toBe(true)
    // Never a fake success: Gate-4 satisfaction is absent and no 'done' event fired.
    expect(servicesBus.recent(id).some(e => e.kind === 'gate' && e.gate === 'push_confirm' && e.state === 'satisfied')).toBe(false)
    expect(servicesBus.recent(id).some(e => e.kind === 'done')).toBe(false)
  })
})
