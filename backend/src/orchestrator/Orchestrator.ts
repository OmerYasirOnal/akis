import { randomUUID } from 'node:crypto'
import { initialSession, isVerified, type SessionState } from '@akis/shared'
import { mintApprovedSpec, SpecNotApprovedError } from '../gates/specGate.js'
import { mintApprovedPush, pushToGitHub } from '../gates/pushGate.js'
import { nextTs } from '../events/clock.js'
import { assembleSharedContext } from '../context/assemble.js'
import type { SharedContext } from '@akis/shared'
import type { OrchestratorServices } from '../di/services.js'
import { buildAdvisoryTools } from '../agent/tools/advisoryTools.js'
import type { AdvisoryPhase } from '../agent/dynamic/AdvisoryAgent.js'
import { signPassport } from '../verify/passport.js'
import type { BuildPassport, VerifyToken } from '@akis/shared'
import { mergeFiles } from './mergeFiles.js'

export interface StartInput {
  idea: string
  ownerId?: string
  /** EDIT MODE (Phase B.5): seed this build with a prior session's app — Proto edits it
   *  (merge semantics) instead of regenerating from scratch. Owner-checked at the API. */
  base?: { files: { filePath: string; content: string }[]; fromSession: string }
}

export class AlreadyPushedError extends Error {
  constructor() { super('Session already pushed (confirmPush is not repeatable)'); this.name = 'AlreadyPushedError' }
}
export class CriticFailedError extends Error {
  constructor(code: string) { super(`Critic/review failed: ${code}`); this.name = 'CriticFailedError' }
}
export class WrongStatusError extends Error {
  constructor(action: string, status: string) { super(`Cannot ${action} from status '${status}'`); this.name = 'WrongStatusError' }
}

/** Default max auto-iterate attempts before a non-converging build needs human
 *  resolution. A workflow may TIGHTEN this (lower it) via services.iterateBudget. */
const DEFAULT_MAX_ITERATE = 3

/** The TERMINAL run states — a run here is over and cannot be cancelled/driven further. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled'])

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

  private narrate(sessionId: string, text: string, opts?: { ephemeral?: boolean }): void {
    this.s.bus.emit({ kind: 'text', text, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs(), ...(opts?.ephemeral ? { ephemeral: true } : {}) })
  }

  private emitGate(sessionId: string, gate: 'spec_approval' | 'push_confirm', state: 'awaiting' | 'satisfied' | 'rejected'): void {
    this.s.bus.emit({ kind: 'gate', gate, state, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  /** Surface a RECOVERABLE run state so the FE can show an ACTION card (not a silent
   *  amber dot). This is NOT a structural gate — it un-parks an AUTOMATIC critic verdict
   *  or a failed verify and never skips verify/push (see the `recovery` event doc). */
  private emitRecovery(sessionId: string, recovery: 'critic_resolution' | 'verify_failed' | 'push_failed', state: 'awaiting' | 'resolved'): void {
    this.s.bus.emit({ kind: 'recovery', recovery, state, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs() })
  }

  /** Surface the critic's READ-ONLY code-review verdict as a status card. It is
   *  AUTOMATIC (not a human gate) and STRUCTURED ONLY — booleans + bounded counts,
   *  no free-form prose — so it is never ingested as trusted RAG grounding. */
  private emitCodeReview(sessionId: string, v: { approved: boolean; findings: number; critical: boolean; iteration: number }): void {
    this.s.bus.emit({ kind: 'code_review', ...v, agent: 'critic', laneId: 'main', sessionId, ts: nextTs() })
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

  /** Dynamic dispatch (CF4): AKIS consults each registered advisory (edge) agent at
   *  a pipeline edge. ADVISORY ONLY — each agent reads context + non-gate tools and
   *  its note is narrated EPHEMERALLY into the live stream (shown live but NOT ingested
   *  into RAG — closes the advisory→RAG injection loop); it never touches a
   *  gate, and a failing/throwing advisor is skipped. So this can never block, fake, or
   *  alter the verified pipeline. No-op when no advisory agents are registered. */
  private async runAdvisory(sessionId: string, phase: AdvisoryPhase, objective: string): Promise<void> {
    const registry = this.s.advisoryAgents
    if (!registry || registry.size === 0) return
    const forPhase = registry.listForPhase(phase)
    if (forPhase.length === 0) return // no agent pinned to (or defaulting into) this edge
    const ctx = await this.ctx(sessionId, objective)
    for (const { agent, capabilities } of forPhase) {
      // Per-agent tool registry: only the non-gate tools it declared that we support
      // (a gate tool can never be here — registration already rejected gate caps).
      const tools = buildAdvisoryTools(capabilities, { knowledge: this.s.knowledge, sessionId })
      try {
        const note = await agent.advise({
          sessionId, phase, objective, ctx, tools,
          // Advisory narration is EPHEMERAL: shown live but not ingested into RAG, so
          // free-form/untrusted advisory text can never become trusted grounding.
          onTool: call => this.narrate(sessionId, `Advisory ${agent.role} used ${call.name}`, { ephemeral: true }),
        })
        this.narrate(sessionId, `💡 Advisory (${note.role}/${phase}): ${note.text}`, { ephemeral: true })
      } catch (e) {
        this.narrate(sessionId, `Advisory (${agent.role}) skipped: ${e instanceof Error ? e.message : String(e)}`, { ephemeral: true })
      }
    }
  }

  async start(input: StartInput): Promise<SessionState> {
    const id = randomUUID()
    let session = initialSession(id, input.idea, input.ownerId)
    // EDIT MODE seed (data only — no gate capability travels with it).
    if (input.base?.files.length) session = { ...session, base: input.base }
    await this.s.store.create(session)
    // F1-AC17: subscribe the ingestion sink AS the session starts, before any event
    // is emitted, so zero-touch ingestion misses nothing (RAG flag on → sink present).
    this.s.ingestionSink?.subscribeSession(id)
    this.s.bus.emit({ kind: 'session', status: 'started', agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    this.narrate(id, `Planning: ${input.idea}`)

    // Edge (advisory): consult any custom agents before drafting the spec. No-op
    // without advisory agents; never gates — only narrates research notes.
    await this.runAdvisory(id, 'pre_scribe', `Research before drafting a spec for: ${input.idea}`)

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
    else {
      this.narrate(id, 'Critic rejected the spec — needs human resolution before approval.')
      // Recoverable, not a dead-end: the FE shows a proceed/abandon action card.
      this.emitRecovery(id, 'critic_resolution', 'awaiting')
    }
    return session
  }

  /**
   * Run control: STOP/CANCEL an in-flight run — a clean, user-requested TERMINAL abandon.
   * It moves the run to `cancelled` (an already-terminal status) from any NON-terminal state;
   * a terminal run (done/failed/cancelled) refuses (WrongStatusError → 409 at the route), so
   * cancel can never disturb a finished run. Best-effort: the orchestrator drives no agents on
   * a fire-and-forget basis, so flipping the status is enough to stop the pipeline from being
   * driven further (every drive method gates on its expected status).
   *
   * CANCEL IS NOT A GATE BYPASS: it only sets a terminal abandon — it NEVER records a
   * VerifyToken, never mints an ApprovedPush, and never pushes. A run cancelled at the push
   * gate is abandoned (the verified-but-unpushed artifact is simply not shipped). The
   * version-safe store update means a concurrent transition just no-ops/conflicts, not ships.
   */
  async cancel(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (TERMINAL_STATUSES.has(cur.status)) throw new WrongStatusError('cancel', cur.status)
    const out = await this.s.store.update(id, { status: 'cancelled' }, cur.version)
    this.narrate(id, 'Run cancelled.')
    // Terminal `session/cancelled`: the live view stops driving the run and the ingestion
    // sink closes out (it unsubscribes on a `done`/non-started session signal).
    this.s.bus.emit({ kind: 'session', status: 'cancelled', agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    return out
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

    const maxIterate = this.s.iterateBudget ?? DEFAULT_MAX_ITERATE
    let feedback: string | undefined
    let lastFiles: { filePath: string; content: string }[] = []
    let attempt = 0
    // EDIT MODE (Phase B.5): a session seeded with a base app EDITS it — Proto sees the
    // current files and emits only what it changes/adds; merging restores the FULL app so
    // the validator, critic and store always see the whole application (gates unchanged).
    // On iterate, the base EVOLVES to the latest merged candidate so the critic's feedback
    // (which describes the candidate) and the files Proto sees stay consistent. A fresh
    // build (no base) keeps today's full-regeneration iterate semantics, byte-identical.
    let baseFiles = session.base?.files
    for (;;) {
      const protoCtx = await this.ctx(id, `${approved.spec.title}\n${approved.spec.body}`)
      const proto = await this.s.proto.run({
        sessionId: id, laneId: 'main', approved, ctx: protoCtx,
        ...(feedback !== undefined ? { feedback } : {}),
        ...(baseFiles?.length ? { baseFiles } : {}),
      })
      const candidate = mergeFiles(baseFiles, proto.files)
      lastFiles = candidate

      const validation = this.s.validator.validate({
        files: candidate.map(f => ({ path: f.filePath, content: f.content, language: 'typescript' as const })),
      })
      const review = await this.s.critic.reviewCode({
        reviewType: 'code_review', artifact: candidate, originalIdea: session.idea, referenceSpec: approved.spec,
      })
      if (review.type === 'error') {
        this.s.bus.emit({ kind: 'error', message: review.error.message, code: review.error.code, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
        this.emitFailed(id)
        throw new CriticFailedError(review.error.code)
      }
      const approvedCode = review.data.approved && validation.passed
      const critical = review.data.hasCriticalFinding
      // Surface the critic verdict as a read-only status card (automatic, not a gate).
      // `approved` reflects the full produce-able verdict (critic approval AND validator),
      // matching the branch the orchestrator actually takes below.
      this.emitCodeReview(id, {
        approved: approvedCode,
        findings: review.data.findings.length,
        critical,
        iteration: review.data.iteration,
      })

      if (approvedCode) {
        session = await this.s.store.update(id, { code: { files: candidate } }, session.version)
        break
      }
      // gatePolicy.requireCriticResolution TIGHTENS the critic gate: any non-approved
      // code goes straight to human resolution instead of auto-iterating.
      const requireResolution = this.s.gatePolicy?.requireCriticResolution === true
      if (critical || requireResolution || attempt >= maxIterate) {
        session = await this.s.store.update(id, { status: 'awaiting_critic_resolution', code: { files: candidate } }, session.version)
        this.narrate(id, critical ? 'Critic raised a critical finding — needs human resolution.' : requireResolution ? 'Workflow requires human resolution of the critic review.' : 'Iterate budget exhausted — needs human resolution.')
        // Recoverable, not a dead-end: the FE shows a proceed/abandon action card. PROCEED
        // continues to the REAL verify + push gates (which still apply); it never bypasses them.
        this.emitRecovery(id, 'critic_resolution', 'awaiting')
        return session
      }
      attempt++
      feedback = review.data.summary
      // Edit-mode only: the next attempt edits the REJECTED CANDIDATE (what the feedback
      // describes), not the original base — otherwise Proto's view and the critic's
      // feedback would drift apart on every iteration.
      if (baseFiles?.length) baseFiles = candidate
      this.narrate(id, `Iterating (attempt ${attempt}) on Proto with feedback.`)
    }

    // Edge (advisory): consult any custom agents on the reviewed build before
    // verification. No-op without advisory agents; never gates — only narrates.
    await this.runAdvisory(id, 'post_code_review', `Advise on the reviewed build for: ${session.idea}`)

    // Gate 2 + 3: only Trace holds a TestRunner; verification is the persisted token.
    return await this.verifyAndTransition(id, session, lastFiles)
  }

  /**
   * Gate 2 + 3 (the verify step, shared by the main run AND the recovery paths). Only Trace
   * holds a TestRunner, so only this can produce the branded TestRunResult a VerifyToken needs;
   * verification is the PRESENCE of the persisted token. On a real ≥1-test pass → push gate
   * opens; on a non-pass (tests failed / 0-test run, NO token) → `verify_failed`, a RETRYABLE
   * state (NOT a silent reset to 'building', the old dead-end). NEVER bypasses verify.
   */
  private async verifyAndTransition(id: string, session: SessionState, files: { filePath: string; content: string }[]): Promise<SessionState> {
    // The run's approved spec rides along (PR2, data only): the boot-smoke verifier derives
    // its acceptance-criteria probes from it. It never shapes the OUTCOME — mint unchanged.
    const { token, evidence } = await this.s.trace.run({ sessionId: id, laneId: 'verify', files, ...(session.spec ? { spec: session.spec } : {}) })
    // ADDITIVE, NON-GATE: the structured evidence (scenarios + counts + durationMs +
    // structured failure) is folded into the SAME normal update patch below. It is
    // OBSERVABILITY ONLY — written via the generic `update` (the gate-field allowlist
    // is unchanged), never via a gate method, and it never affects the token/gate.
    const evidencePatch = evidence ? { testEvidence: evidence } : {}
    if (token) {
      const verified = await this.s.store.recordVerification(id, token, session.version)
      // ADDITIVE, OFF the gate path: produce the durable, third-party-verifiable Build
      // Passport. It is signed AFTER the token was already minted+persisted, over the
      // token's ALREADY-MINTED facts — so it can only ATTEST verification, never mint or
      // forge it. Folded into the SAME non-gate update patch (the gate-write allowlist is
      // unchanged); no-op when no signer is configured (default boot unchanged).
      const passportPatch = this.signPassportFor(token)
      const out = await this.s.store.update(id, { status: 'awaiting_push_confirm', ...evidencePatch, ...passportPatch }, verified.version)
      this.emitGate(id, 'push_confirm', 'awaiting')
      return out
    }
    // No token (real verify did not pass). Persist the structured failure evidence
    // alongside a RETRYABLE `verify_failed` status (NOT a silent reset to 'building'),
    // so a failed run's named failing scenarios survive on GET /sessions/:id and the
    // human can retry (re-runs REAL verification). The recovery signal drives the FE card.
    const out = await this.s.store.update(id, { status: 'verify_failed', ...evidencePatch }, session.version)
    this.narrate(id, '⚠️ Not verified — no real passing test was produced. Retry to re-run the tests.')
    this.emitRecovery(id, 'verify_failed', 'awaiting')
    return out
  }

  /**
   * Recovery for `awaiting_critic_resolution` (the AUTOMATIC critic did not approve and the
   * iterate budget/policy parked the run). The Critic is NOT a structural gate; this un-parks
   * its verdict WITHOUT skipping any structural gate:
   *  - 'abandon' → `cancelled` (terminal).
   *  - 'proceed' → accept the non-approval and continue. If the SPEC was never approved
   *    (parked at the spec step, no ApprovalToken), this opens the STRUCTURAL spec-approval
   *    gate (awaiting_spec_approval) — Gate 1 still applies, the human still approves. If the
   *    spec WAS approved (parked at the code step, code present), it continues to the REAL
   *    verify + push-confirm gates (Gate 3 still requires a genuine ≥1-test pass).
   */
  async resolveCritic(id: string, decision: 'proceed' | 'abandon'): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.status !== 'awaiting_critic_resolution') throw new WrongStatusError('resolve critic', cur.status)

    if (decision === 'abandon') {
      const out = await this.s.store.update(id, { status: 'cancelled' }, cur.version)
      this.narrate(id, 'Run abandoned at the critic review.')
      this.emitRecovery(id, 'critic_resolution', 'resolved')
      return out
    }

    // PROCEED. Spec not yet approved (spec-step park) → open the structural spec gate;
    // the human must still satisfy Gate 1 before any code is produced.
    if (!cur.approval) {
      const out = await this.s.store.update(id, { status: 'awaiting_spec_approval' }, cur.version)
      this.narrate(id, 'Proceeding past the critic — approve the spec to run the pipeline.')
      this.emitRecovery(id, 'critic_resolution', 'resolved')
      this.emitGate(id, 'spec_approval', 'awaiting')
      return out
    }
    // Code-step park (spec approved, code present): continue to the REAL verify + push gates.
    const files = cur.code?.files ?? []
    this.narrate(id, 'Proceeding past the critic — running real verification.')
    this.emitRecovery(id, 'critic_resolution', 'resolved')
    return await this.verifyAndTransition(id, cur, files)
  }

  /**
   * Recovery for `verify_failed` (real verification returned no token). Re-enters the verify
   * step and RE-RUNS REAL verification on the already-produced code; mint still requires a
   * genuine ≥1-test pass (NO bypass). Bounded — a single retry per call (the human re-clicks
   * to retry again), and the produce-side iterate budget is unchanged.
   */
  async retryVerification(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.status !== 'verify_failed') throw new WrongStatusError('retry verification', cur.status)
    // Gate 1 (structural): mintApprovedSpec throws unless a valid approval token exists, so a
    // retry can never run without the still-required spec approval.
    mintApprovedSpec(cur)
    const files = cur.code?.files ?? []
    this.narrate(id, 'Retrying — re-running real verification.')
    return await this.verifyAndTransition(id, cur, files)
  }

  /** Sign a durable Build Passport over an ALREADY-MINTED VerifyToken's facts. Returns a
   *  patch fragment ({ passport }) to fold into the normal (non-gate) update, or {} when no
   *  signer is configured. PURE attestation: it reads only the token's already-earned facts;
   *  it can never mint/forge verification. The orchestrator holds the private key but it is
   *  reachable ONLY via the signer's sign path — never logged, never returned. */
  private signPassportFor(token: VerifyToken): { passport?: BuildPassport } {
    const signer = this.s.passportSigner
    if (!signer) return {}
    const passport = signPassport(
      { sessionId: token.sessionId, testsRun: token.testsRun, codeDigest: token.codeDigest, evidenceDigest: token.evidenceDigest },
      signer,
    )
    return { passport }
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
      // RECOVERABLE, not a dead-end: park retryable. The FE surfaces a "Push failed — retry"
      // action that re-runs the GATED confirmPush (Gate 4 still mints from the VerifyToken).
      this.emitRecovery(id, 'push_failed', 'awaiting')
      throw err
    }
    this.s.bus.emit({ kind: 'tool_result', tool: 'push_to_github', ok: true, result: { url: repoUrl }, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    // The pushed repo is the produced artifact's home — a real URL the UI can open
    // (mock adapter today; a real preview env lands in the preview sub-project).
    this.s.bus.emit({ kind: 'preview', url: repoUrl, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    const session = await this.s.store.update(id, { status: 'done' }, cur.version)
    // If this was a retry of a failed push, clear the recovery card (idempotent on replay).
    if (cur.status === 'push_failed') this.emitRecovery(id, 'push_failed', 'resolved')
    this.emitGate(id, 'push_confirm', 'satisfied')
    this.s.bus.emit({ kind: 'done', verified: isVerified(session), provider: this.s.providerName, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })

    // Issue #7 AC1: auto-ingest the just-pushed repo into RAG grounding (no manual
    // POST needed). PURELY ADDITIVE grounding, OFF the gate path: it runs AFTER the
    // push succeeded and the session is already persisted 'done'. The RepoSource reads
    // the SAME shared `github` adapter we just pushed to, mirroring the manual repo
    // route's arg shape ({sessionId,userId} with userId = ragUserIdFor). Fire-and-forget
    // for FAILURE: awaited but try/catch-wrapped so a thrown/failed ingest can NEVER
    // fail confirmPush, change the session status, or touch the push gate. No-op when
    // RAG/repoSource is absent (keyless / RAG-off default is byte-for-byte unchanged).
    if (this.s.repoSource) {
      const userId = this.s.ragUserIdFor?.(id) ?? id
      try {
        await this.s.repoSource.ingest({ sessionId: id, userId })
      } catch (err) {
        this.narrate(id, `Repo auto-ingest skipped: ${err instanceof Error ? err.message : String(err)}`, { ephemeral: true })
      }
    }
    return session
  }
}

export { SpecNotApprovedError }
