import { randomUUID } from 'node:crypto'
import { initialSession, type SessionState } from '@akis/shared'
import { canUseTool } from '../tools/permission.js'
import { deriveVerified } from '../gates/verifiedReducer.js'
import { mintApprovedPush, pushToGitHub } from '../gates/pushGate.js'
import { nextTs } from '../events/clock.js'
import type { OrchestratorServices } from '../di/services.js'
import type { ProtoInput } from './subagents/ProtoAgent.js'

export interface StartInput { idea: string }

/** Max auto-iterate attempts before a non-converging build needs human resolution. */
const MAX_ITERATE = 3

/**
 * The conversational orchestrator. It decides the flow (no rigid FSM) and
 * narrates each step, but the 4 structural gates constrain it:
 *  1. Gate 1 — it cannot dispatch Proto (code-write) before spec approval.
 *  2. Gate 2 — it never runs tests; only Trace (the verifier) does.
 *  3. Gate 3 — `verified` is derived from a real Trace test run.
 *  4. Gate 4 — push needs an ApprovedPush token (verified + human confirm).
 */
export class Orchestrator {
  constructor(private s: OrchestratorServices) {}

  private narrate(sessionId: string, text: string): void {
    this.s.bus.emit({ kind: 'text', text, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  private emitGate(sessionId: string, gate: 'spec_approval' | 'push_confirm', state: 'awaiting' | 'satisfied' | 'rejected'): void {
    this.s.bus.emit({ kind: 'gate', gate, state, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  async start(input: StartInput): Promise<SessionState> {
    const id = randomUUID()
    let session = initialSession(id, input.idea)
    await this.s.store.create(session)
    this.s.bus.emit({ kind: 'session', status: 'started', agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    this.narrate(id, `Planning: ${input.idea}`)

    const scribeOut = await this.s.scribe.run({ sessionId: id, laneId: 'main', idea: input.idea })
    if (scribeOut.type === 'clarify') {
      this.narrate(id, `Scribe needs clarification: ${scribeOut.questions.join(' ')}`)
      return await this.s.store.update(id, { status: 'composing' }, session.version)
    }

    const specReview = await this.s.critic.reviewSpec({ reviewType: 'spec_review', artifact: scribeOut.spec, originalIdea: input.idea })
    if (specReview.type === 'review') {
      this.narrate(id, `Critic spec score: ${specReview.data.overallScore}`)
    }

    session = await this.s.store.update(id, { spec: scribeOut.spec, status: 'awaiting_spec_approval' }, session.version)
    this.emitGate(id, 'spec_approval', 'awaiting')
    return session
  }

  async approve(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (!cur.spec) throw new Error('no spec to approve')
    const session = await this.s.store.update(id, { approvedSpec: cur.spec, status: 'building' }, cur.version)
    this.emitGate(id, 'spec_approval', 'satisfied')
    return session
  }

  async runToVerification(id: string): Promise<SessionState> {
    let session = await this.s.store.get(id)
    if (!session) throw new Error(`session ${id} not found`)

    // Gate 1 (structural): no code-write before spec approval.
    const verdict = canUseTool('orchestrator', 'dispatch_proto', session)
    if (!verdict.ok) {
      this.s.bus.emit({ kind: 'error', message: verdict.reason, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
      throw new Error(verdict.reason)
    }
    const approvedSpec = session.approvedSpec!

    await this.s.github.createRepo(id)

    let feedback: string | undefined
    let attempt = 0
    // Agentic iterate loop: re-dispatch Proto on non-critical failure, capped.
    for (;;) {
      const protoInput: ProtoInput = {
        sessionId: id, laneId: 'main', spec: approvedSpec,
        ...(feedback !== undefined ? { feedback } : {}),
      }
      const proto = await this.s.proto.run(protoInput)

      const validation = this.s.validator.validate({
        files: proto.files.map(f => ({ path: f.filePath, content: f.content, language: 'typescript' as const })),
      })
      const review = await this.s.critic.reviewCode({
        reviewType: 'code_review', artifact: proto.files, originalIdea: session.idea, referenceSpec: approvedSpec,
      })
      const approved = review.type === 'review' && review.data.approved && validation.passed
      const critical = review.type === 'review' && review.data.hasCriticalFinding

      if (approved) {
        session = await this.s.store.update(id, { code: { files: proto.files } }, session.version)
        break
      }
      if (critical || attempt >= MAX_ITERATE) {
        session = await this.s.store.update(id, { status: 'awaiting_critic_resolution', code: { files: proto.files } }, session.version)
        this.narrate(id, critical ? 'Critic raised a critical finding — needs human resolution.' : 'Iterate budget exhausted — needs human resolution.')
        return session
      }
      attempt++
      feedback = review.type === 'review' ? review.data.summary : 'address validation issues'
      this.narrate(id, `Iterating (attempt ${attempt}) on Proto with feedback.`)
    }

    // Trace (verifier) — the only role permitted to run tests.
    await this.s.trace.run({ sessionId: id, laneId: 'verify', files: session.code?.files ?? [] })
    const verified = deriveVerified(this.s.bus.recent(id))
    if (verified) {
      session = await this.s.store.update(id, { verified: true, status: 'awaiting_push_confirm' }, session.version)
      this.emitGate(id, 'push_confirm', 'awaiting')
    } else {
      session = await this.s.store.update(id, { verified: false }, session.version)
      this.narrate(id, '⚠️ Not verified — Trace did not run a real passing test.')
    }
    return session
  }

  async confirmPush(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    // Gate 4: mint throws NotVerifiedError unless verified; the branded token is
    // the only key to pushToGitHub.
    const token = mintApprovedPush(cur)
    await pushToGitHub(token, this.s.github, cur.code?.files ?? [])
    const session = await this.s.store.update(id, { status: 'done' }, cur.version)
    this.emitGate(id, 'push_confirm', 'satisfied')
    this.s.bus.emit({ kind: 'done', verified: session.verified, provider: this.s.provider.name, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    return session
  }
}
