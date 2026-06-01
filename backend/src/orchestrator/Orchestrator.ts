import { randomUUID } from 'node:crypto'
import { initialSession, isVerified, type SessionState } from '@akis/shared'
import { mintApprovedSpec, SpecNotApprovedError } from '../gates/specGate.js'
import { mintApprovedPush, pushToGitHub } from '../gates/pushGate.js'
import { nextTs } from '../events/clock.js'
import type { OrchestratorServices } from '../di/services.js'

export interface StartInput { idea: string }

export class AlreadyPushedError extends Error {
  constructor() { super('Session already pushed (confirmPush is not repeatable)'); this.name = 'AlreadyPushedError' }
}
export class CriticFailedError extends Error {
  constructor(code: string) { super(`Critic/review failed: ${code}`); this.name = 'CriticFailedError' }
}
export class WrongStatusError extends Error {
  constructor(action: string, status: string) { super(`Cannot ${action} from status '${status}'`); this.name = 'WrongStatusError' }
}

/** Max auto-iterate attempts before a non-converging build needs human resolution. */
const MAX_ITERATE = 3

/**
 * Conversational orchestrator. It decides the flow (no rigid FSM) and narrates,
 * but the 4 gates are STRUCTURAL — enforced by branded tokens + the verifier's
 * exclusive TestRunner, not by discipline:
 *  - Gate 1: ProtoAgent.run requires an ApprovedSpec token (only approve() mints it).
 *  - Gate 2: only Trace holds a TestRunner, so only Trace can produce a VerifyToken.
 *  - Gate 3: verification = the presence of a persisted VerifyToken (real ≥1-test
 *    pass), never a free boolean or an event; the store cannot fabricate it.
 *  - Gate 4: pushToGitHub requires ApprovedPush, mintable only from the session's
 *    VerifyToken with a digest matching the pushed files.
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
    if (specReview.type === 'error') {
      this.s.bus.emit({ kind: 'error', message: specReview.error.message, code: specReview.error.code, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
      throw new CriticFailedError(specReview.error.code)
    }
    this.narrate(id, `Critic spec score: ${specReview.data.overallScore}`)

    const status = specReview.data.approved ? 'awaiting_spec_approval' : 'awaiting_critic_resolution'
    session = await this.s.store.update(id, { spec: scribeOut.spec, status }, session.version)
    if (status === 'awaiting_spec_approval') this.emitGate(id, 'spec_approval', 'awaiting')
    else this.narrate(id, 'Critic rejected the spec — needs human resolution before approval.')
    return session
  }

  async approve(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.status !== 'awaiting_spec_approval') throw new WrongStatusError('approve', cur.status)
    if (!cur.spec) throw new Error('no spec to approve')
    // Bind approval to the exact reviewed spec content.
    const session = await this.s.store.update(id, { approvedSpec: cur.spec, status: 'building' }, cur.version)
    this.emitGate(id, 'spec_approval', 'satisfied')
    return session
  }

  async runToVerification(id: string): Promise<SessionState> {
    let session = await this.s.store.get(id)
    if (!session) throw new Error(`session ${id} not found`)
    if (session.status !== 'building') throw new WrongStatusError('build', session.status)

    // Gate 1 (structural): mint throws SpecNotApprovedError unless approve() ran.
    // ProtoAgent cannot even be called without this token.
    const approved = mintApprovedSpec(session)

    let feedback: string | undefined
    let lastFiles: { filePath: string; content: string }[] = []
    let attempt = 0
    for (;;) {
      const proto = await this.s.proto.run({
        sessionId: id, laneId: 'main', approved,
        ...(feedback !== undefined ? { feedback } : {}),
      })
      lastFiles = proto.files

      const validation = this.s.validator.validate({
        files: proto.files.map(f => ({ path: f.filePath, content: f.content, language: 'typescript' as const })),
      })
      const review = await this.s.critic.reviewCode({
        reviewType: 'code_review', artifact: proto.files, originalIdea: session.idea, referenceSpec: approved.spec,
      })
      if (review.type === 'error') {
        this.s.bus.emit({ kind: 'error', message: review.error.message, code: review.error.code, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
        throw new CriticFailedError(review.error.code)
      }
      const approvedCode = review.data.approved && validation.passed
      const critical = review.data.hasCriticalFinding

      if (approvedCode) {
        session = await this.s.store.update(id, { code: { files: proto.files } }, session.version)
        break
      }
      if (critical || attempt >= MAX_ITERATE) {
        session = await this.s.store.update(id, { status: 'awaiting_critic_resolution', code: { files: proto.files } }, session.version)
        this.narrate(id, critical ? 'Critic raised a critical finding — needs human resolution.' : 'Iterate budget exhausted — needs human resolution.')
        return session
      }
      attempt++
      feedback = review.data.summary
      this.narrate(id, `Iterating (attempt ${attempt}) on Proto with feedback.`)
    }

    // Gate 2 + 3: only Trace holds a TestRunner; verification is the presence of
    // the persisted VerifyToken it returns (never a free boolean / event).
    const token = await this.s.trace.run({ sessionId: id, laneId: 'verify', files: lastFiles })
    if (token) {
      session = await this.s.store.update(id, { verifyToken: token, status: 'awaiting_push_confirm' }, session.version)
      this.emitGate(id, 'push_confirm', 'awaiting')
    } else {
      session = await this.s.store.update(id, { status: 'building' }, session.version)
      this.narrate(id, '⚠️ Not verified — no real passing test was produced.')
    }
    return session
  }

  async confirmPush(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.status === 'done') throw new AlreadyPushedError()
    if (cur.status !== 'awaiting_push_confirm') throw new WrongStatusError('push', cur.status)

    const files = cur.code?.files ?? []
    // Gate 4: mint requires the persisted VerifyToken AND a digest match; throws otherwise.
    const token = mintApprovedPush(cur, files)
    // Persist terminal status FIRST (atomic, optimistic-locked) so a duplicate
    // call cannot slip past the guard, THEN perform the idempotent push.
    const session = await this.s.store.update(id, { status: 'done' }, cur.version)
    await pushToGitHub(token, this.s.github, files)
    this.emitGate(id, 'push_confirm', 'satisfied')
    this.s.bus.emit({ kind: 'done', verified: isVerified(session), provider: this.s.providerName, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    return session
  }
}

export { SpecNotApprovedError }
