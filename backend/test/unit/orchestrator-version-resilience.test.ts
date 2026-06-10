/**
 * DEMO-BLOCKER A1: the build pipeline's session writes are RESILIENT to optimistic-lock
 * version conflicts.
 *
 * ROOT CAUSE (live-verified 2026-06-10): runPipeline captured `session` (and its .version)
 * ONCE at the top and committed every later write with that STALE version. Meanwhile
 * chatAppend writes the SAME session on every completed chat turn and bumps the version —
 * and chatAppend already retries on conflict. The asymmetry killed an otherwise-successful
 * build with RunFailed "version conflict: N !== M" whenever the user typed during a build.
 *
 * These tests inject a competing chatAppend-style writer that bumps the session version
 * between the pipeline's read and a pipeline write, and assert:
 *  (1) ONE intervening write → the build still completes AND both the chat turn and the
 *      produced code survive on the final row (regression: TODAY this throws RunFailed).
 *  (2) A writer that bumps the version on EVERY attempt → the run still fails CLEANLY
 *      (RunFailed surfaced, bounded ≤ MAX attempts, no infinite loop).
 *  (3) A concurrent CANCEL mid-pipeline is NOT resurrected by the resilient retry.
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { isVerified, type SessionState, type ChatTurn } from '@akis/shared'
import type { SessionPatch } from '../../src/store/SessionStore.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function makeOrch(store: MockSessionStore) {
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: 90,
    testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
  })
  return { orch: new Orchestrator(services), services }
}

/** A chatAppend-style competing write: appends a chat turn at the CURRENT stored version,
 *  bumping it — exactly what the real chatAppend does on a completed chat turn during a build. */
async function competingChatWrite(store: MockSessionStore, id: string, content: string): Promise<void> {
  const cur = await store.get(id)
  if (!cur) throw new Error('competing write: session vanished')
  const turn: ChatTurn = { role: 'user', content, at: new Date().toISOString() }
  await store.update(id, { chat: [...(cur.chat ?? []), turn] }, cur.version)
}

describe('Orchestrator A1 — pipeline writes survive a concurrent version bump', () => {
  it('ONE chat write between the read and the code-commit no longer kills the build — both the chat turn AND the code survive', async () => {
    const store = new MockSessionStore()
    const { orch, services } = makeOrch(store)

    // Intercept the store's generic update so we can inject ONE competing chat write the FIRST
    // time the pipeline tries to commit the produced `code`. The injected write bumps the version,
    // so the pipeline's optimistic update conflicts — TODAY that throws RunFailed; AFTER the fix
    // updateResilient re-reads the fresh row and retries.
    const realUpdate = store.update.bind(store)
    let injected = false
    store.update = async (uid: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState> => {
      if (!injected && uid && 'code' in patch && patch.code) {
        injected = true
        await competingChatWrite(store, uid, 'are we done yet?') // <-- a live chat turn mid-build
      }
      return realUpdate(uid, patch, expectedVersion)
    }

    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    // Deterministic (awaited) run — the regression is purely about the version asymmetry.
    const verified = await orch.runToVerification(s.id)

    expect(injected).toBe(true) // the competing write actually fired (the race we are testing)
    expect(verified.status).toBe('awaiting_push_confirm')
    expect(isVerified(verified)).toBe(true)

    const final = (await services.store.get(s.id))!
    // The CODE survived (the build's produced files).
    expect(final.code?.files.length).toBeGreaterThan(0)
    // The CHAT TURN survived (the competing writer's append was not clobbered by the retry).
    expect(final.chat?.some(t => t.content === 'are we done yet?')).toBe(true)
  })

  it('exhaustion: a writer that bumps the version on EVERY attempt → the run fails CLEANLY (RunFailed surfaced, bounded ≤ MAX, no infinite loop)', async () => {
    const store = new MockSessionStore()
    const { orch, services } = makeOrch(store)

    // Inject a competing write on EVERY code-commit attempt, so the optimistic update can never
    // win. The resilient loop must give up after MAX retries and rethrow — not spin forever.
    const realUpdate = store.update.bind(store)
    let codeCommitAttempts = 0
    store.update = async (uid: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState> => {
      if (uid && 'code' in patch && patch.code) {
        codeCommitAttempts++
        // Bump the version right before EACH code commit so it always conflicts.
        await competingChatWrite(store, uid, `interrupt #${codeCommitAttempts}`)
      }
      return realUpdate(uid, patch, expectedVersion)
    }

    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    // runToVerification awaits runPipeline directly, so the (eventually) exhausted retry surfaces
    // as a thrown error here — a clean RunFailed-shaped surface, not a hang.
    await expect(orch.runToVerification(s.id)).rejects.toThrow(/version conflict/)

    // Bounded: the helper attempts the original + MAX_RESILIENT_WRITE_RETRY(=5) retries = 6 tries.
    // It must NOT loop unboundedly (a regression here would be a hang, not a wrong count).
    expect(codeCommitAttempts).toBeLessThanOrEqual(6)
    expect(codeCommitAttempts).toBeGreaterThanOrEqual(2) // it really did retry, not give up immediately

    // The session is NOT verified/shipped — a failed write never fakes a gate.
    const final = (await services.store.get(s.id))!
    expect(isVerified(final)).toBe(false)
    expect(final.status).not.toBe('done')
  })

  it('cancel honesty: a CANCEL that lands mid-pipeline is NOT resurrected by the resilient retry', async () => {
    const store = new MockSessionStore()
    const { orch, services } = makeOrch(store)

    // The first time the pipeline attempts to commit `code`, simulate a concurrent cancel landing
    // (flip the row to the terminal 'cancelled' status at the current version). The resilient
    // writer must REFUSE to overwrite it — never resurrect the abandoned run.
    const realUpdate = store.update.bind(store)
    let cancelled = false
    store.update = async (uid: string, patch: SessionPatch, expectedVersion: number): Promise<SessionState> => {
      if (!cancelled && uid && 'code' in patch && patch.code) {
        cancelled = true
        const cur = await store.get(uid)
        await realUpdate(uid, { status: 'cancelled' }, cur!.version) // a concurrent cancel
      }
      return realUpdate(uid, patch, expectedVersion)
    }

    const s = await orch.start({ idea: 'build a todo web app' })
    await orch.approve(s.id)
    // The resilient writer detects the cancelled row on its fresh re-read and refuses → the run
    // stops with an error rather than overwriting the cancel.
    await expect(orch.runToVerification(s.id)).rejects.toBeTruthy()

    const final = (await services.store.get(s.id))!
    expect(final.status).toBe('cancelled') // cancel WON — not resurrected to building/push_confirm
    expect(isVerified(final)).toBe(false)
    expect(services.github.read(s.id)).toHaveLength(0)
  })
})
