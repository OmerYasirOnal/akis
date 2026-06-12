import { describe, it, expect } from 'vitest'
import { foldRunBubbles, type AgentMsg, type GateMsg, type CodeReviewMsg, type RecoveryMsg, type VerifyMsg } from './chatModel.js'
import type { AkisEvent } from '@akis/shared'

const ev = (e: Partial<AkisEvent> & { kind: AkisEvent['kind'] }): AkisEvent =>
  ({ agent: 'orchestrator', laneId: 'main', sessionId: 's1', ts: 0, ...(e as object) }) as AkisEvent

describe('foldRunBubbles', () => {
  it('does NOT emit a synthetic user-idea bubble (the idea lives in the chat spine)', () => {
    expect(foldRunBubbles([])).toEqual([])
    const msgs = foldRunBubbles([ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' })])
    expect(msgs.some(m => m.kind === 'user')).toBe(false)
  })

  it('builds an agent turn with its tools and closes it', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'agent_start', role: 'scribe', agent: 'scribe' }),
      ev({ kind: 'tool_call', tool: 'dispatch_scribe', agent: 'scribe' }),
      ev({ kind: 'tool_result', tool: 'dispatch_scribe', ok: true, agent: 'scribe' }),
      ev({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe' }),
    ])
    const turn = msgs.find(m => m.kind === 'agent') as AgentMsg
    expect(turn.agent).toBe('scribe')
    expect(turn.done).toBe(true)
    expect(turn.tools).toEqual([{ tool: 'dispatch_scribe', ok: true }])
    expect(turn.attempts).toBe(1)
  })

  it('COALESCES an agent re-run (critic-driven iterate loop) into ONE bubble with attempts++ (no stacked duplicates)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto' }),
      ev({ kind: 'code_review', approved: false, findings: 3, critical: false, iteration: 1, agent: 'critic' }),
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }), // round 2 — the critic asked for changes
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto' }),
    ])
    const protoTurns = msgs.filter(m => m.kind === 'agent') as AgentMsg[]
    expect(protoTurns).toHaveLength(1) // ONE Proto bubble, not two stacked identical ones
    expect(protoTurns[0]!.attempts).toBe(2)
    expect(protoTurns[0]!.done).toBe(true)
    // Proto stays before the critic card (chronological anchor of its FIRST turn is preserved).
    expect(msgs.findIndex(m => m.kind === 'agent')).toBeLessThan(msgs.findIndex(m => m.kind === 'code_review'))
  })

  it('shows orchestrator narration as its own (suppressible) bubble when no turn is open', () => {
    const msgs = foldRunBubbles([ev({ kind: 'text', text: 'Planning: x' })])
    expect(msgs.some(m => m.kind === 'narration' && m.text === 'Planning: x')).toBe(true)
  })

  it('folds text into an open agent turn notes (not a standalone narration bubble)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }),
      ev({ kind: 'text', text: 'writing index.html', agent: 'proto' }),
    ])
    const turn = msgs.find(m => m.kind === 'agent') as AgentMsg
    expect(turn.notes).toEqual(['writing index.html'])
    expect(msgs.some(m => m.kind === 'narration')).toBe(false)
  })

  it('keeps a single gate card that updates in place (awaiting → satisfied)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'spec_approval', state: 'awaiting' }),
      ev({ kind: 'gate', gate: 'spec_approval', state: 'satisfied' }),
    ])
    const gateCards = msgs.filter(m => m.kind === 'gate') as GateMsg[]
    expect(gateCards).toHaveLength(1)
    expect(gateCards[0]!.state).toBe('satisfied')
  })

  it('A2.1: carries the per-project delivery on the push_confirm gate, retained across the satisfied update', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting', delivery: { owner: 'ada', repo: 'todo-app' } }),
      ev({ kind: 'gate', gate: 'push_confirm', state: 'satisfied' }), // no delivery on satisfied
    ])
    const gateCards = msgs.filter(m => m.kind === 'gate') as GateMsg[]
    expect(gateCards).toHaveLength(1)
    expect(gateCards[0]!.state).toBe('satisfied')
    // The destination is RETAINED (not cleared) after the satisfied event.
    expect(gateCards[0]!.delivery).toEqual({ owner: 'ada', repo: 'todo-app' })
  })

  // ── A3.5 — a PARKED push (recovery push_failed 'awaiting') contradicts a still-'awaiting'
  //    push_confirm gate row: the backend NEVER emits a gate event on a push failure (gates are
  //    sacred — only the success path moves the gate), so the inline GateBubble kept showing
  //    "Confirm push" right above the push_failed Retry card — two actionable rows for ONE action.
  //    The fold (presentation layer ONLY) drops the awaiting push_confirm GateMsg in that case;
  //    the RecoveryBubble's retry drives the SAME gated confirm path, so exactly one row remains. ──
  it('A3.5: gate(push_confirm awaiting) then recovery(push_failed awaiting) folds with NO awaiting gate card', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
    ])
    expect(msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm' && m.state === 'awaiting')).toHaveLength(0)
    expect(msgs.some(m => m.kind === 'recovery' && m.recovery === 'push_failed' && m.state === 'awaiting')).toBe(true)
  })

  it('A3.5: the ORDER-REVERSED sequence (recovery first, gate after) folds the same way (post-pass)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
    ])
    expect(msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm' && m.state === 'awaiting')).toHaveLength(0)
    expect(msgs.some(m => m.kind === 'recovery' && m.recovery === 'push_failed' && m.state === 'awaiting')).toBe(true)
  })

  // F5 — dropping the awaiting push_confirm gate also drops the only renderer of the push DESTINATION
  // (delivery). The post-pass COPIES it onto the surviving push_failed recovery so the retry card can
  // still show "→ github.com/owner/repo".
  it('F5: the dropped gate\'s delivery is carried onto the surviving push_failed recovery card', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting', delivery: { owner: 'ada', repo: 'todo-app' } }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
    ])
    expect(msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm' && m.state === 'awaiting')).toHaveLength(0)
    const rec = msgs.find(m => m.kind === 'recovery' && m.recovery === 'push_failed') as RecoveryMsg
    expect(rec.state).toBe('awaiting')
    expect(rec.delivery).toEqual({ owner: 'ada', repo: 'todo-app' })
  })

  it('F5: a gate without delivery (anonymous/keyless) leaves the recovery delivery-less (no-op)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
    ])
    const rec = msgs.find(m => m.kind === 'recovery' && m.recovery === 'push_failed') as RecoveryMsg
    expect(rec.delivery).toBeUndefined()
  })

  // F7 — on a successful retry the orchestrator emits recovery 'resolved' BEFORE gate 'satisfied', so
  // for ONE frame the gate is still 'awaiting' while the recovery is already 'resolved'. The
  // resurrection window: the old awaiting-only suppression let the Confirm-push card reappear (click →
  // AlreadyPushed 409). Suppress on resolved-too closes it; once gate 'satisfied' lands, it folds normally.
  it('F7: gate(awaiting) → recovery(awaiting) → recovery(resolved) [no gate satisfied yet] → NO actionable gate card', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'resolved' }), // retry succeeded; gate satisfied not emitted yet
    ])
    // The one-frame resurrection is closed: no awaiting push_confirm gate card survives.
    expect(msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm' && m.state === 'awaiting')).toHaveLength(0)
    // The recovery is resolved (its bubble renders nothing) — exactly zero actionable rows for the push.
    expect(msgs.some(m => m.kind === 'recovery' && m.recovery === 'push_failed' && m.state === 'awaiting')).toBe(false)
  })

  it('F7: then the gate satisfied event folds normally (the satisfied singleton card is back)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'resolved' }),
      ev({ kind: 'gate', gate: 'push_confirm', state: 'satisfied' }),
      ev({ kind: 'done', verified: true, provider: 'mock' }),
    ])
    const gateCards = msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm') as GateMsg[]
    expect(gateCards).toHaveLength(1)
    expect(gateCards[0]!.state).toBe('satisfied') // not awaiting → GateBubble renders nothing; no resurrection
  })

  it('A3.5: a retry SUCCESS continuation (gate satisfied + recovery resolved) keeps the satisfied gate card', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'push_failed', state: 'resolved' }), // the retry succeeded
      ev({ kind: 'gate', gate: 'push_confirm', state: 'satisfied' }),
      ev({ kind: 'done', verified: true, provider: 'mock' }),
    ])
    const gateCards = msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm') as GateMsg[]
    expect(gateCards).toHaveLength(1) // normal gate behavior resumed — the singleton card is back
    expect(gateCards[0]!.state).toBe('satisfied')
    // No contradictory card: the recovery is resolved (the bubble renders nothing when resolved).
    expect(msgs.some(m => m.kind === 'recovery' && m.recovery === 'push_failed' && m.state === 'awaiting')).toBe(false)
  })

  it('A3.5: an awaiting push_confirm gate WITHOUT a push failure is untouched (the normal gate moment)', () => {
    const msgs = foldRunBubbles([ev({ kind: 'gate', gate: 'push_confirm', state: 'awaiting' })])
    expect(msgs.filter(m => m.kind === 'gate' && m.gate === 'push_confirm' && m.state === 'awaiting')).toHaveLength(1)
  })

  it('folds a recovery into a singleton card that flips awaiting → resolved in place', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'recovery', recovery: 'critic_resolution', state: 'awaiting' }),
      ev({ kind: 'recovery', recovery: 'critic_resolution', state: 'resolved' }),
    ])
    const recs = msgs.filter(m => m.kind === 'recovery')
    expect(recs).toHaveLength(1)
    expect(recs[0]).toMatchObject({ kind: 'recovery', recovery: 'critic_resolution', state: 'resolved' })
  })

  // P0-3a — the verify event's honest-failure breakdown folds onto the VerifyMsg (real testsRun even
  // on a fail) AND is COPIED onto the verify_failed recovery card (the actionable surface the user
  // reads). Both must reflect the REAL counts, never "0 test".
  it('P0-3a: a FAILED verify event folds the real counts onto the verify bubble (not 0 test)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'verify', testsRun: 11, passed: false, passedCount: 7, failedCount: 1, unmeasuredCount: 3, failingScenarios: [{ name: 'delete (Sil)', reason: 'missing literal' }], agent: 'trace', laneId: 'verify' }),
    ])
    const v = msgs.find(m => m.kind === 'verify') as VerifyMsg
    expect(v.testsRun).toBe(11) // the REAL executed count, not 0
    expect(v.passed).toBe(false)
    expect(v).toMatchObject({ passedCount: 7, failedCount: 1, unmeasuredCount: 3 })
    expect(v.failingScenarios).toEqual([{ name: 'delete (Sil)', reason: 'missing literal' }])
  })

  it('P0-3a: the verify evidence is COPIED onto the verify_failed recovery card (verify BEFORE recovery)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'verify', testsRun: 11, passed: false, passedCount: 7, failedCount: 1, unmeasuredCount: 3, failingScenarios: [{ name: 'delete (Sil)', reason: 'missing literal' }], agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }),
    ])
    const rec = msgs.find(m => m.kind === 'recovery' && m.recovery === 'verify_failed') as RecoveryMsg
    expect(rec.verifyEvidence).toMatchObject({ testsRun: 11, passedCount: 7, failedCount: 1, unmeasuredCount: 3 })
    expect(rec.verifyEvidence?.failingScenarios).toEqual([{ name: 'delete (Sil)', reason: 'missing literal' }])
  })

  it('P0-3a: the copy is ORDER-INDEPENDENT (recovery BEFORE verify still gets the evidence)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }),
      ev({ kind: 'verify', testsRun: 8, passed: false, passedCount: 5, failedCount: 2, unmeasuredCount: 1, agent: 'trace', laneId: 'verify' }),
    ])
    const rec = msgs.find(m => m.kind === 'recovery' && m.recovery === 'verify_failed') as RecoveryMsg
    expect(rec.verifyEvidence).toMatchObject({ testsRun: 8, passedCount: 5, failedCount: 2, unmeasuredCount: 1 })
  })

  it('P0-3a: a PASSING verify never decorates a verify_failed card (no false failure evidence)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }),
      // (a verify_failed recovery would never fire on a pass, but prove the guard if it somehow did)
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }),
    ])
    const rec = msgs.find(m => m.kind === 'recovery' && m.recovery === 'verify_failed') as RecoveryMsg
    expect(rec.verifyEvidence).toBeUndefined() // guarded by !verifyMsg.passed
  })

  it('P0-3a: an evidence-less FAILED verify leaves the card without fabricated counts (graceful)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'verify', testsRun: 0, passed: false, agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'recovery', recovery: 'verify_failed', state: 'awaiting' }),
    ])
    const rec = msgs.find(m => m.kind === 'recovery' && m.recovery === 'verify_failed') as RecoveryMsg
    // verifyEvidence is still set (carries the real testsRun:0) but has NO invented breakdown.
    expect(rec.verifyEvidence?.testsRun).toBe(0)
    expect(rec.verifyEvidence?.passedCount).toBeUndefined()
    expect(rec.verifyEvidence?.failingScenarios).toBeUndefined()
  })

  it('carries the per-agent metrics from agent_end onto the agent bubble (honest cost transparency)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'agent_start', role: 'proto', agent: 'proto' }),
      ev({ kind: 'agent_end', role: 'proto', ok: true, agent: 'proto', metrics: { usage: { inTokens: 8000, outTokens: 4345 }, durationMs: 42_000, toolCalls: 1 } }),
    ])
    const turn = msgs.find(m => m.kind === 'agent') as AgentMsg
    expect(turn.metrics).toMatchObject({ durationMs: 42_000, toolCalls: 1 })
  })

  it('renders a read-only code_review card and updates it in place (last verdict wins)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'code_review', approved: false, findings: 3, critical: false, iteration: 1, agent: 'critic' }),
      ev({ kind: 'code_review', approved: true, findings: 0, critical: false, iteration: 2, agent: 'critic' }),
    ])
    const cards = msgs.filter(m => m.kind === 'code_review') as CodeReviewMsg[]
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ kind: 'code_review', approved: true, findings: 0, critical: false, iteration: 2 })
  })

  it('renders verify, preview and done cards', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'verify', testsRun: 3, passed: true, agent: 'trace', laneId: 'verify' }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'done', verified: true, provider: 'anthropic' }),
    ])
    expect(msgs.some(m => m.kind === 'verify' && m.passed)).toBe(true)
    expect(msgs.some(m => m.kind === 'preview' && m.ready && m.url === '/preview/s1/')).toBe(true)
    expect(msgs.some(m => m.kind === 'done' && m.verified)).toBe(true)
  })

  it('surfaces a recoverable preview failure as a preview card carrying its reason', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'preview_status', status: 'failed', reason: 'port in use' }),
    ])
    const preview = msgs.find(m => m.kind === 'preview')
    expect(preview).toMatchObject({ kind: 'preview', ready: false, error: { status: 'failed', reason: 'port in use' } })
  })

  // F3 — a projected replay ending in 'stopped' (the registry couldn't back the prior 'ready' after a
  // restart, so the url was stripped) must CLEAR the singleton's earlier dead url and mark it stopped,
  // never retain a clickable dead link rendered as "starting…".
  it('a [ready(url) → stopped] fold CLEARS the url and marks the preview stopped (no dead link)', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'stopped' }), // url already stripped by the backend projection
    ])
    const preview = msgs.find(m => m.kind === 'preview')
    expect(preview).toMatchObject({ kind: 'preview', ready: false, stopped: true })
    expect((preview as { url?: string }).url).toBeUndefined() // the earlier dead url did NOT linger
  })

  it('a stopped frame that STILL carries a url (belt-and-suspenders) drops it', () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'stopped', url: '/preview/s1/' }),
    ])
    expect((msgs.find(m => m.kind === 'preview') as { url?: string }).url).toBeUndefined()
  })

  it("a 'failed' frame after a 'ready' clears the url too (the dead link must not render)", () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'failed', reason: 'crashed' }),
    ])
    const preview = msgs.find(m => m.kind === 'preview')
    expect(preview).toMatchObject({ kind: 'preview', ready: false, error: { status: 'failed', reason: 'crashed' } })
    expect((preview as { url?: string }).url).toBeUndefined()
  })

  it("a 'ready' AFTER a 'stopped' re-adds the url and clears the stopped flag (a re-run supersedes)", () => {
    const msgs = foldRunBubbles([
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
      ev({ kind: 'preview_status', status: 'stopped' }),
      ev({ kind: 'preview_status', status: 'ready', url: '/preview/s1/' }),
    ])
    const preview = msgs.find(m => m.kind === 'preview')
    expect(preview).toMatchObject({ kind: 'preview', ready: true, url: '/preview/s1/' })
    expect((preview as { stopped?: boolean }).stopped).toBeUndefined()
  })

  it('appends an error row', () => {
    const msgs = foldRunBubbles([ev({ kind: 'error', message: 'boom' })])
    expect(msgs.some(m => m.kind === 'error' && m.text === 'boom')).toBe(true)
  })
})
