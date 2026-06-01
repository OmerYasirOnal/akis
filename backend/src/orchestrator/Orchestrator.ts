import { randomUUID } from 'node:crypto'
import { initialSession, isVerified, type SessionState } from '@akis/shared'
import { mintApprovedSpec, SpecNotApprovedError } from '../gates/specGate.js'
import { mintApprovedPush, pushToGitHub } from '../gates/pushGate.js'
import { nextTs } from '../events/clock.js'
import { assembleSharedContext } from '../context/assemble.js'
import type { SharedContext } from '@akis/shared'
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
 * but the 4 gates are STRUCTURAL — branded capability tokens + a verifier-only
 * TestRunner, not discipline:
 *  - Gate 1: code-write needs an ApprovedSpec, mintable only from the session's
 *    ApprovalToken, which only the store's recordApproval (via approve()) writes.
 *  - Gate 2: only Trace holds a TestRunner, so only Trace can produce the branded
 *    TestRunResult a VerifyToken requires.
 *  - Gate 3: verification = a persisted, nominal-branded VerifyToken (real
 *    ≥1-test pass); it cannot be written as a literal or via a generic patch.
 *  - Gate 4: push needs an ApprovedPush, mintable only from the VerifyToken with
 *    a digest matching the pushed files.
 */
export class Orchestrator {
  constructor(private s: OrchestratorServices) {}

  private narrate(sessionId: string, text: string): void {
    this.s.bus.emit({ kind: 'text', text, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  private emitGate(sessionId: string, gate: 'spec_approval' | 'push_confirm', state: 'awaiting' | 'satisfied' | 'rejected'): void {
    this.s.bus.emit({ kind: 'gate', gate, state, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  /** Emit the terminal `session/failed` so live consumers (and the RAG ingestion
   *  sink) can close out the session — used on unrecoverable throws, NOT on the
   *  retryable push_failed path. */
  private emitFailed(sessionId: string): void {
    this.s.bus.emit({ kind: 'session', status: 'failed', agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  /** Assemble the typed read view AKIS dispatches each agent with (F2-AC16/AC17).
   *  It carries data only — no gate capability — so a dispatched agent can read
   *  context but cannot reach a gate through it. */
  private ctx(sessionId: string, query: string): Promise<SharedContext> {
    return assembleSharedContext(sessionId, { store: this.s.store, bus: this.s.bus, knowledge: this.s.knowledge }, { query })
  }

  async start(input: StartInput): Promise<SessionState> {
    const id = randomUUID()
    let session = initialSession(id, input.idea)
    await this.s.store.create(session)
    // F1-AC17: subscribe the ingestion sink AS the session starts, before any event
    // is emitted, so zero-touch ingestion misses nothing (RAG flag on → sink present).
    this.s.ingestionSink?.subscribeSession(id)
    this.s.bus.emit({ kind: 'session', status: 'started', agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    this.narrate(id, `Planning: ${input.idea}`)

    const scribeCtx = await this.ctx(id, input.idea)
    const scribeOut = await this.s.scribe.run({ sessionId: id, laneId: 'main', idea: input.idea, ctx: scribeCtx })
    if (scribeOut.type === 'clarify') {
      this.narrate(id, `Scribe needs clarification: ${scribeOut.questions.join(' ')}`)
      return await this.s.store.update(id, { status: 'composing' }, session.version)
    }

    const specReview = await this.s.critic.reviewSpec({ reviewType: 'spec_review', artifact: scribeOut.spec, originalIdea: input.idea })
    if (specReview.type === 'error') {
      this.s.bus.emit({ kind: 'error', message: specReview.error.message, code: specReview.error.code, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
      this.emitFailed(id)
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
    // Gate 1: persist a branded ApprovalToken bound to the exact reviewed spec.
    // The approval mint is held only by the orchestrator's ApprovalAuthority.
    const approving = await this.s.store.recordApproval(id, this.s.approvalAuthority.approve(cur.spec), cur.version)
    const session = await this.s.store.update(id, { status: 'building' }, approving.version)
    this.emitGate(id, 'spec_approval', 'satisfied')
    return session
  }

  async runToVerification(id: string): Promise<SessionState> {
    let session = await this.s.store.get(id)
    if (!session) throw new Error(`session ${id} not found`)
    if (session.status !== 'building') throw new WrongStatusError('build', session.status)

    // Gate 1 (structural): throws SpecNotApprovedError unless a valid approval token exists.
    const approved = mintApprovedSpec(session)

    let feedback: string | undefined
    let lastFiles: { filePath: string; content: string }[] = []
    let attempt = 0
    for (;;) {
      const protoCtx = await this.ctx(id, `${approved.spec.title}\n${approved.spec.body}`)
      const proto = await this.s.proto.run({
        sessionId: id, laneId: 'main', approved, ctx: protoCtx,
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
        this.emitFailed(id)
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

    // Gate 2 + 3: only Trace holds a TestRunner; verification is the persisted token.
    const token = await this.s.trace.run({ sessionId: id, laneId: 'verify', files: lastFiles })
    if (token) {
      const verified = await this.s.store.recordVerification(id, token, session.version)
      session = await this.s.store.update(id, { status: 'awaiting_push_confirm' }, verified.version)
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
    if (cur.status !== 'awaiting_push_confirm' && cur.status !== 'push_failed') throw new WrongStatusError('push', cur.status)

    const files = cur.code?.files ?? []
    // Gate 4: mint requires the persisted VerifyToken AND a digest match; throws otherwise.
    const token = mintApprovedPush(cur, files)

    // Push FIRST. Only persist 'done' after a successful push, so a push failure
    // leaves a retryable state (push_failed) and never loses the code.
    this.s.bus.emit({ kind: 'tool_call', tool: 'push_to_github', args: { files: files.length }, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    let repoUrl: string
    try {
      repoUrl = await this.s.github.createRepo(id)
      await pushToGitHub(token, this.s.github, files)
    } catch (err) {
      await this.s.store.update(id, { status: 'push_failed' }, cur.version)
      this.s.bus.emit({ kind: 'tool_result', tool: 'push_to_github', ok: false, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
      this.s.bus.emit({ kind: 'error', message: `push failed: ${err instanceof Error ? err.message : String(err)}`, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
      throw err
    }
    this.s.bus.emit({ kind: 'tool_result', tool: 'push_to_github', ok: true, result: { url: repoUrl }, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    // The pushed repo is the produced artifact's home — a real URL the UI can open
    // (mock adapter today; a real preview env lands in the preview sub-project).
    this.s.bus.emit({ kind: 'preview', url: repoUrl, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    const session = await this.s.store.update(id, { status: 'done' }, cur.version)
    this.emitGate(id, 'push_confirm', 'satisfied')
    this.s.bus.emit({ kind: 'done', verified: isVerified(session), provider: this.s.providerName, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    return session
  }
}

export { SpecNotApprovedError }
