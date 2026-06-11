import { randomUUID } from 'node:crypto'
import { initialSession, isVerified, CANCEL_IMMUNE_STATUSES, type SessionState, type SpecArtifact } from '@akis/shared'
import { languageFor } from '../validator/ValidatorTypes.js'
import { mintApprovedSpec, SpecNotApprovedError } from '../gates/specGate.js'
import { mintApprovedPush, pushToGitHub } from '../gates/pushGate.js'
import { nextTs } from '../events/clock.js'
import { assembleSharedContext } from '../context/assemble.js'
import type { SharedContext } from '@akis/shared'
import type { OrchestratorServices } from '../di/services.js'
import { MockGitHubAdapter } from '../di/MockGitHubAdapter.js'
import type { SessionPatch } from '../store/SessionStore.js'
import { buildAdvisoryTools } from '../agent/tools/advisoryTools.js'
import type { AdvisoryPhase } from '../agent/dynamic/AdvisoryAgent.js'
import { signPassport } from '../verify/passport.js'
import type { BuildPassport, VerifyToken } from '@akis/shared'
import { mergeFiles } from './mergeFiles.js'
import { backendRequirementGap } from './backendRequirement.js'
import { wantsRepoContext } from './repoContextIntent.js'

export interface StartInput {
  idea: string
  ownerId?: string
  /**
   * P0-1: an AUTHORITATIVE, chat-approved spec seed. When present, `start()` uses it as the
   * SpecArtifact instead of re-running Scribe over the idea (so the chat's approved spec is not
   * silently re-authored), and AUTO-SATISFIES Gate 1 by minting the ApprovedSpec through the
   * SAME approvalAuthority path `approve()` uses — the human already expressed spec-approval
   * intent at the chat SpecCard, so the pipeline opens already at spec-approved with NO second
   * 'awaiting_spec_approval' gate and NO second human click. The structural gate is PRESERVED:
   * the ApprovedSpec is still minted server-side via the approvalAuthority; Proto still cannot
   * run without it. Absent ⇒ behavior is byte-identical to today (Scribe runs, gate emits).
   */
  spec?: { title: string; body: string }
  /** EDIT MODE (Phase B.5): seed this build with a prior session's app — Proto edits it
   *  (merge semantics) instead of regenerating from scratch. Owner-checked at the API. */
  base?: { files: { filePath: string; content: string }[]; fromSession: string }
  /** EDIT MODE companion (A2.1 review MED-1): the BASE app's pinned per-project repo. A
   *  change-request is the SAME project, so its PR must land in the SAME repo (owner model:
   *  project = repo) — without this, the edit would derive a fresh collision-suffixed repo.
   *  Data only (owner/name strings); no gate capability travels with it. resolveDelivery
   *  treats it as already-pinned, so no re-derivation/probe happens for the edit. */
  delivery?: { owner: string; repo: string }
  /**
   * OPTIONAL pre-build conversation (the spec-shaping turns typed BEFORE this build existed). Baked
   * into the INITIAL session state at version 0 — BEFORE mintSpecApproval/kickRun — so there is
   * exactly ONE creation write and NO post-start update racing the fire-and-forget pipeline (which
   * reads `version` then writes; a chat patch landing between bumped the version → the pipeline's
   * {code} write conflicted → a silent `failed`). The route validates/bounds it (role, non-empty
   * content, ISO `at`, CHAT_TURNS_MAX) before passing it here. GATE-SAFE: `chat` is the existing
   * non-gate column — conversation text only, never approve/verify/push/mint. Absent/empty ⇒
   * byte-identical to today (no `chat` field set).
   */
  chat?: import('@akis/shared').ChatTurn[]
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
/**
 * A real-mode (authenticated-owner) session reached confirmPush but the owner has NO usable
 * GitHub delivery destination — no connected account + target repo. HONESTY: rather than
 * silently push to the in-memory MockGitHubAdapter and report a FAKE `github.com/mock/<id>`
 * "success", confirmPush refuses with this so the FE can localize a "Connect GitHub in
 * Settings" message + CTA. The mock stays the legitimate destination ONLY for tests/demo
 * (anonymous sessions, NODE_ENV=test / no connections store). Gate-NEUTRAL: this changes
 * WHETHER a usable destination exists, never whether/how a push is authorized — Gate-4 still
 * mints the ApprovedPush from the digest-bound VerifyToken before this is ever reached.
 */
export class NoGitHubDestinationError extends Error {
  readonly code = 'NoGitHubDestinationError'
  constructor() {
    super('No GitHub delivery destination — connect a GitHub account and target repo in Settings')
    this.name = 'NoGitHubDestinationError'
  }
}
/** A pipeline write found the session already CANCELLED on the fresh re-read. The
 *  resilient writer REFUSES to resurrect a user-cancelled run (preserving cancel
 *  semantics), so it throws this; the fire-and-forget kickRun catch leaves the
 *  terminal 'cancelled' status untouched (its catch only fails a still-'building' row). */
export class RunCancelledError extends Error {
  constructor() { super('Run was cancelled mid-pipeline — not resurrecting'); this.name = 'RunCancelledError' }
}

/** Default max auto-iterate attempts before a non-converging build needs human
 *  resolution. A workflow may TIGHTEN this (lower it) via services.iterateBudget. */
const DEFAULT_MAX_ITERATE = 3

/** Max read-modify-write retries on an optimistic-lock conflict for a pipeline session write
 *  before giving up (matches appendExternalWrite's MAX_RETRY + patchExternalWrite's budget). */
const MAX_RESILIENT_WRITE_RETRY = 5

/** A4 — statuses cancel() REFUSES to overwrite: the terminal set (done/failed/cancelled) PLUS the
 *  parked-but-RETRYABLE states. push_failed/verify_failed are not dead ends — confirmPush accepts a
 *  push_failed retry and retryVerification re-runs a failed verify — so a blind cancel (e.g. the
 *  FE's 'New build' firing against a stale status snapshot) must not destroy the retry by stamping
 *  'cancelled' over the park. The live-gate parks (awaiting_push_confirm / awaiting_critic_resolution)
 *  STAY cancellable — abandoning at a gate is a legitimate, user-requested stop.
 *
 *  F8 — this is the SHARED set (shared/src/session.ts CANCEL_IMMUNE_STATUSES); the frontend's
 *  terminal-vs-live decision reads the SAME const, so the backend cancel-refusal (the authoritative
 *  guard) and the FE's pre-cancel decision can never drift apart. */
const CANCEL_IMMUNE: ReadonlySet<string> = CANCEL_IMMUNE_STATUSES

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

  private emitGate(sessionId: string, gate: 'spec_approval' | 'push_confirm', state: 'awaiting' | 'satisfied' | 'rejected', delivery?: { owner: string; repo: string }): void {
    // A2.1: a pinned per-project `delivery` rides ONLY the push_confirm AWAITING gate so the FE shows
    // the target before confirm. ADDITIVE/optional — never present on other gates, carries no token.
    this.s.bus.emit({ kind: 'gate', gate, state, agent: 'orchestrator', laneId: 'main', sessionId, ts: nextTs(), ...(delivery ? { delivery } : {}) })
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

  /** Kick the build pipeline FIRE-AND-FORGET (the seeded-start auto-run). Failures must land in
   *  the session + bus — the FE is SSE-driven and there is no awaiting HTTP caller to carry the
   *  error — never vanish as an unhandled rejection. Known pipeline failures already emitFailed
   *  before throwing; this catch covers the rest (provider/network/store errors) and moves a
   *  still-'building' session to 'failed' so the UI can offer retry instead of waiting forever. */
  private kickRun(id: string): void {
    void this.runToVerification(id).catch(async (err: unknown) => {
      // A user-initiated Stop is NOT a failure: the resilient writer refuses the cancelled row
      // (RunCancelledError) and the session already sits terminal-'cancelled' with its own status
      // event — emitting a red RunFailed bubble for a deliberate cancel would be a false alarm
      // (and raw English in a TR session). Stay silent; the status-flip guard below is already a
      // no-op for non-'building' rows.
      if (err instanceof RunCancelledError) return
      const msg = err instanceof Error ? err.message : String(err)
      this.s.bus.emit({ kind: 'error', message: msg, code: 'RunFailed', agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
      try {
        const cur = await this.s.store.get(id)
        if (cur && cur.status === 'building') {
          await this.s.store.update(id, { status: 'failed' }, cur.version)
          this.emitFailed(id)
        }
      } catch { /* the bus error above stays the last word — never throw from a forgotten promise */ }
    })
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
    // Bake the validated pre-build conversation into the CREATION state (version 0) — NOT a
    // post-create patch. This is the race fix: a concurrent {chat} write after the fire-and-forget
    // pipeline reads `version` would bump it and conflict the pipeline's {code} write → a silent
    // `failed`. Seeding at creation means a single write and no concurrent update. NON-GATE (chat).
    let session = initialSession(id, input.idea, input.ownerId, input.chat)
    // EDIT MODE seed (data only — no gate capability travels with it).
    if (input.base?.files.length) session = { ...session, base: input.base }
    // SAME PROJECT → SAME REPO (A2.1 MED-1): an edit inherits the base app's pinned delivery
    // destination, so its PR lands in the base project's repo instead of a fresh `-2` derivation.
    if (input.delivery) session = { ...session, delivery: input.delivery }
    await this.s.store.create(session)
    // F1-AC17: subscribe the ingestion sink AS the session starts, before any event
    // is emitted, so zero-touch ingestion misses nothing (RAG flag on → sink present).
    this.s.ingestionSink?.subscribeSession(id)
    // Stamp the owner ONLY on the started emit (ADDITIVE/observability) so the usage tap can
    // attribute this run's token spend to the owning user — never a gate input. Cancel/fail
    // emits stay unchanged (the tap maps on started and prunes on terminal).
    this.s.bus.emit({ kind: 'session', status: 'started', agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs(), ...(input.ownerId ? { ownerId: input.ownerId } : {}) })
    this.narrate(id, `Planning: ${input.idea}`)

    // P0-1: an AUTHORITATIVE chat-approved spec seed short-circuits the spec stage entirely.
    // The human ALREADY approved this exact spec at the chat SpecCard, so we DO NOT re-run
    // Scribe (which would author a DIFFERENT spec) nor its spec-stage critic review (which can
    // spuriously park). We persist the seeded spec and AUTO-SATISFY Gate 1 by minting the
    // ApprovedSpec through the SAME approvalAuthority path approve() uses — never a literal,
    // never a generic patch. The pipeline opens already at 'building' (spec-approved), ready
    // for Proto, with NO second human click and NO 'awaiting_spec_approval' gate emit.
    if (input.spec) {
      const spec = { title: input.spec.title, body: input.spec.body }
      session = await this.s.store.update(id, { spec, status: 'awaiting_spec_approval' }, session.version)
      this.narrate(id, 'Using the spec you approved in chat — no second approval needed.')
      const approved = await this.mintSpecApproval(id, spec, session.version)
      // CHAT-SEEDED PATH: Scribe's run() is short-circuited here (the spec was already authored +
      // approved in chat, so re-running Scribe would author a DIFFERENT spec). ScribeAgent.run() is
      // the ONLY emitter of scribe agent_start/agent_end, so without this the roster would derive
      // Scribe as 'idle' ("beklemede") even though the spec stage is genuinely DONE. Record that stage
      // with a synthetic agent_start immediately followed by agent_end(ok:true), using the SAME payload
      // shape ScribeAgent.run() emits. GATE-SAFE: these are pure observability bus EVENTS — no LLM
      // call, no store write, no gate authority, no token mint; the spec gate stays minted exactly once.
      this.s.bus.emit({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId: 'main', sessionId: id, ts: nextTs() })
      // F3 — HONEST DURATION: this synthetic start/end fire BACK-TO-BACK at session start, so a wall-clock
      // duration would be a meaningless "0s" (the REAL drafting happened earlier, at chat time, by the
      // chat persona's Scribe handoff). So we OMIT durationMs entirely — only the honest zero tool-call
      // count rides. usage stays ABSENT (the reverted double-charge seam: UsageCollector taps agent_end,
      // so a usage block here would re-bill Scribe's chat-time spend). The FE renders a metrics-less
      // Scribe stage as an honest "spec was drafted in chat" caption instead of a fabricated timing line.
      this.s.bus.emit({ kind: 'agent_end', role: 'scribe', ok: true, metrics: { toolCalls: 0 }, agent: 'scribe', laneId: 'main', sessionId: id, ts: nextTs() })
      // The SpecCard's "Approve & Build" is the SINGLE human action for BOTH the gate and the
      // run (#124 collapsed the separate Approve click) — so the RUN must be kicked HERE,
      // server-side. Fire-and-forget: awaiting it would hold the POST /sessions response open
      // for the whole multi-minute pipeline. Caught LIVE: without this kick NOBODY starts the
      // run — the FE's only api.run caller is the legacy in-pipeline gate card, which a
      // seeded start never shows — so every chat build wedged at 'building' forever.
      this.kickRun(id)
      return approved
    }

    // Edge (advisory): consult any custom agents before drafting the spec. No-op
    // without advisory agents; never gates — only narrates research notes.
    await this.runAdvisory(id, 'pre_scribe', `Research before drafting a spec for: ${input.idea}`)

    const scribeCtx = await this.ctx(id, input.idea)
    // SP1 (TIGHTEN/ADDITIVE): resolve per-owner READ-ONLY GitHub-MCP wiring just-in-time, exactly
    // like the githubFor pattern (confirmPush). githubMcpFor returns {pool,ownerId,token} ONLY when
    // a non-empty token resolves for the owner. SMART TRIGGER: only wire it when the IDEA actually
    // signals the user wants their connected repo as reference (wantsRepoContext) — so a plain build
    // never spawns the github-MCP Docker child. No owner / no connection / no repo-intent ⇒ undefined
    // ⇒ the Scribe path is byte-identical to today (no Docker spawn).
    const githubMcp = input.ownerId && wantsRepoContext(input.idea) ? this.s.githubMcpFor?.(input.ownerId) : undefined
    const scribeOut = await this.s.scribe.run({
      sessionId: id, laneId: 'main', idea: input.idea, ctx: scribeCtx,
      ...(githubMcp ? { githubMcp } : {}),
    })
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
    // A4: terminal AND parked-retryable (push_failed/verify_failed) statuses refuse — see
    // CANCEL_IMMUNE. Same WrongStatusError → 409 via CONFLICT_ERRORS at the route.
    if (CANCEL_IMMUNE.has(cur.status)) throw new WrongStatusError('cancel', cur.status)
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
    return await this.mintSpecApproval(id, cur.spec, cur.version)
  }

  /**
   * Gate 1 — the SINGLE spec-approval mint path. Persists a branded ApprovalToken bound to the
   * exact reviewed spec (the mint is held only by the orchestrator's ApprovalAuthority — never a
   * literal, never a generic patch), advances the session to 'building', and emits the
   * 'spec_approval' satisfied gate. Shared by the human gate (`approve()`) AND the chat-approved
   * spec seed (`start()` with a spec) so BOTH express the human's spec-approval intent through
   * one byte-identical mint — the trigger MOMENT moves up to the chat SpecCard, the code path
   * stays identical. `expectedVersion` is the caller's optimistic-lock cursor.
   */
  private async mintSpecApproval(id: string, spec: SpecArtifact, expectedVersion: number): Promise<SessionState> {
    const approving = await this.s.store.recordApproval(id, this.s.approvalAuthority.approve(spec), expectedVersion)
    const session = await this.s.store.update(id, { status: 'building' }, approving.version)
    this.emitGate(id, 'spec_approval', 'satisfied')
    return session
  }

  /** Session ids with a pipeline run currently in flight — the synchronous check-and-set in
   *  runToVerification() makes a concurrent second run (seeded-start auto-kick + a stray
   *  POST /run, or two parallel POST /run) fail FAST with a 409 instead of running Proto twice
   *  and only colliding later on the store's optimistic lock (after double token spend). */
  private readonly inFlightRuns = new Set<string>()

  /**
   * RESILIENT, version-safe session write for the build pipeline (demo-blocker A1). The pipeline
   * captures `session` (and its .version) ONCE at the top of runPipeline and committed every later
   * write with that STALE version. Meanwhile chatAppend (server.ts) writes the SAME session on every
   * completed chat turn and bumps the version — and chatAppend already retries on conflict. The
   * asymmetry killed an otherwise-successful build with RunFailed "version conflict" whenever the
   * user typed during a build. This re-reads the FRESH row each attempt, re-applies the caller's
   * patch onto it, and commits at the fresh version — the SAME `/version conflict/`-ONLY, bounded
   * (MAX_RESILIENT_WRITE_RETRY) read-modify-write loop as appendExternalWrite + chatAppend +
   * patchExternalWrite (NFR-reliability-7/8). NON-GATE ONLY: it routes through the store's GENERIC
   * `update`, whose SessionPatch type structurally excludes every gate column (approval / verifyToken
   * / base) — so this can never mint or flip a gate; it carries no gate value forward.
   *
   * CANCEL HONESTY: `cancel()` flips the row to terminal 'cancelled' via a version-checked update.
   * If the fresh re-read shows 'cancelled', this REFUSES to overwrite (throws RunCancelledError)
   * rather than resurrect the abandoned run — preserving today's behavior, where the cancel bumped
   * the version and the pipeline's stale-version write simply conflicted and died.
   *
   * `patch` may be a plain SessionPatch or a function of the fresh row (used when the new value
   * must be re-derived from the latest persisted state). Returns the committed (post-write) row so
   * callers can keep `session = await ...` reassignment semantics for later steps.
   */
  private async updateResilient(
    id: string,
    patch: SessionPatch | ((fresh: SessionState) => SessionPatch),
  ): Promise<SessionState> {
    for (let attempt = 0; ; attempt++) {
      const fresh = await this.s.store.get(id)
      if (!fresh) throw new Error(`session ${id} not found`)
      // Concurrent-cancel honesty: never resurrect a user-cancelled run by overwriting status.
      if (fresh.status === 'cancelled') throw new RunCancelledError()
      const next = typeof patch === 'function' ? patch(fresh) : patch
      try {
        return await this.s.store.update(id, next, fresh.version)
      } catch (e) {
        // ONLY an optimistic-lock conflict is retryable (a live chat turn / another writer bumped
        // the version between our read and write). Anything else (or exhaustion) rethrows, so a
        // genuine failure still surfaces as RunFailed instead of looping forever.
        if (attempt >= MAX_RESILIENT_WRITE_RETRY || !/version conflict/.test(e instanceof Error ? e.message : '')) throw e
        // else: re-read the FRESH row + retry the optimistic update.
      }
    }
  }

  async runToVerification(id: string): Promise<SessionState> {
    // Check-and-set BEFORE the first await — race-tight under Node's single-threaded turns.
    if (this.inFlightRuns.has(id)) throw new WrongStatusError('build', 'building (a run is already in flight)')
    this.inFlightRuns.add(id)
    try {
      return await this.runPipeline(id)
    } finally { this.inFlightRuns.delete(id) }
  }

  private async runPipeline(id: string): Promise<SessionState> {
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
    // SP1: resolve the per-owner READ-ONLY github handle ONCE for the whole build loop. SMART
    // TRIGGER: only when the spec/idea signals the user wants their connected repo as reference
    // (wantsRepoContext) — so a plain build never spawns the github-MCP Docker child nor runs Proto's
    // extra gather pass. No owner / no connection / no repo-intent ⇒ undefined ⇒ byte-identical to today.
    const githubMcp = session.ownerId && wantsRepoContext(`${approved.spec.title}\n${approved.spec.body}\n${session.idea}`)
      ? this.s.githubMcpFor?.(session.ownerId) : undefined
    // Proto gathers the bounded github repo context ONCE on attempt 0 and returns it; we cache it
    // here and thread it back on every iterate round so the github read pass never re-runs per attempt.
    let repoContext: string | undefined
    for (;;) {
      const protoCtx = await this.ctx(id, `${approved.spec.title}\n${approved.spec.body}`)
      const proto = await this.s.proto.run({
        sessionId: id, laneId: 'main', approved, ctx: protoCtx,
        ...(feedback !== undefined ? { feedback } : {}),
        ...(baseFiles?.length ? { baseFiles } : {}),
        ...(githubMcp ? { githubMcp } : {}),
        ...(repoContext !== undefined ? { repoContext } : {}),
      })
      repoContext = proto.repoContext // cache the (gathered-once) context for the next iterate round
      const candidate = mergeFiles(baseFiles, proto.files)
      lastFiles = candidate

      const validation = this.s.validator.validate({
        // Language BY EXTENSION (audit #46): a generated README (.md), JSON, CSS, etc. must not all be
        // syntax-balance-checked as TypeScript (which false-flagged non-code files like the Scribe doc).
        files: candidate.map(f => ({ path: f.filePath, content: f.content, language: languageFor(f.filePath) })),
      })
      // TIGHTEN-ONLY deterministic guard (caught LIVE): a spec that explicitly demands user
      // accounts / a real backend must not ship as a STATIC localStorage simulation — the
      // "Potemkin backend". A gap blocks approval and feeds Proto actionable iterate feedback;
      // it can never loosen anything (approval only gets stricter) and never bypasses a gate.
      const backendGap = backendRequirementGap(approved.spec, candidate)
      const review = await this.s.critic.reviewCode({
        reviewType: 'code_review', artifact: candidate, originalIdea: session.idea, referenceSpec: approved.spec,
      })
      if (review.type === 'error') {
        this.s.bus.emit({ kind: 'error', message: review.error.message, code: review.error.code, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
        this.emitFailed(id)
        throw new CriticFailedError(review.error.code)
      }
      const approvedCode = review.data.approved && validation.passed && !backendGap
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
        // A1: NON-GATE write (only `code`, structurally excluded from any gate column) routed
        // through the version-resilient writer — a chat turn mid-build no longer kills it.
        session = await this.updateResilient(id, { code: { files: candidate } })
        break
      }
      // gatePolicy.requireCriticResolution TIGHTENS the critic gate: any non-approved
      // code goes straight to human resolution instead of auto-iterating.
      const requireResolution = this.s.gatePolicy?.requireCriticResolution === true
      if (critical || requireResolution || attempt >= maxIterate) {
        // A1: NON-GATE write (status + code; both in SessionPatch, no gate column) — resilient.
        session = await this.updateResilient(id, { status: 'awaiting_critic_resolution', code: { files: candidate } })
        this.narrate(id, critical ? 'Critic raised a critical finding — needs human resolution.' : requireResolution ? 'Workflow requires human resolution of the critic review.' : 'Iterate budget exhausted — needs human resolution.')
        // Recoverable, not a dead-end: the FE shows a proceed/abandon action card. PROCEED
        // continues to the REAL verify + push gates (which still apply); it never bypasses them.
        this.emitRecovery(id, 'critic_resolution', 'awaiting')
        return session
      }
      attempt++
      // The backend gap LEADS the feedback (the structural miss matters more than style notes).
      feedback = [backendGap, review.data.summary].filter(Boolean).join('\n')
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
    // ADDITIVE + fail-soft: Scribe authors a README INTO the verified file set, so the docs ship +
    // push with the app through the SAME Gate 4 (the README is digest-bound into the VerifyToken,
    // re-checked by the push gate). Done HERE — the single verify choke point — so docs land on BOTH
    // the main approved path and the proceed-from-resolution path, generated exactly once. writeDocs
    // returns undefined on any error/mock output, so documentation can NEVER block a build.
    if (session.spec) {
      const docs = await this.s.scribe.writeDocs({ spec: session.spec, files })
      if (docs) {
        files = mergeFiles(files, [docs])
        // A1: NON-GATE write (only `code`) — resilient. The README must ride INTO the verified
        // file set BEFORE Trace runs (it is digest-bound into the VerifyToken), so persisting it
        // at the fresh version here cannot affect the gate; it only keeps `code` current.
        session = await this.updateResilient(id, { code: { files } })
        this.narrate(id, 'Scribe wrote a README and bundled it with the app.')
      }
    }
    // The run's approved spec rides along (PR2, data only): the boot-smoke verifier derives
    // its acceptance-criteria probes from it. It never shapes the OUTCOME — mint unchanged.
    const { token, evidence } = await this.s.trace.run({ sessionId: id, laneId: 'verify', files, ...(session.spec ? { spec: session.spec } : {}) })
    // ADDITIVE, NON-GATE: the structured evidence (scenarios + counts + durationMs +
    // structured failure) is folded into the SAME normal update patch below. It is
    // OBSERVABILITY ONLY — written via the generic `update` (the gate-field allowlist
    // is unchanged), never via a gate method, and it never affects the token/gate.
    const evidencePatch = evidence ? { testEvidence: evidence } : {}
    if (token) {
      // A1 + GATE-3: this write is GATE-BEARING (recordVerification is the ONLY path that persists a
      // VerifyToken). The retry is mint-SAFE because the token was ALREADY minted by Trace BEFORE this
      // loop — it is a fully-formed, nominal-branded VerifyToken bound to THIS `id`. Re-recording that
      // SAME token at a FRESH version only re-PERSISTS the existing proof; it does not (and cannot)
      // re-mint or fabricate verification — the branded token is the proof, the row version is not. We
      // therefore re-read the fresh version each attempt and re-record the identical token, never a
      // stale/forged one. (recordVerification is a gate method, not the generic `update`, so it can't
      // go through updateResilient — but it uses the IDENTICAL /version conflict/-only bounded loop.)
      // The returned verified row is intentionally not threaded forward: the non-gate update below
      // re-reads the FRESH version itself, so it self-heals past whatever version recordVerification
      // landed at (or a writer that slipped in after it).
      for (let attempt = 0; ; attempt++) {
        const fresh = await this.s.store.get(id)
        if (!fresh) throw new Error(`session ${id} not found`)
        if (fresh.status === 'cancelled') throw new RunCancelledError() // never resurrect a cancel
        try {
          await this.s.store.recordVerification(id, token, fresh.version)
          break
        } catch (e) {
          if (attempt >= MAX_RESILIENT_WRITE_RETRY || !/version conflict/.test(e instanceof Error ? e.message : '')) throw e
        }
      }
      // ADDITIVE, OFF the gate path: produce the durable, third-party-verifiable Build
      // Passport. It is signed AFTER the token was already minted+persisted, over the
      // token's ALREADY-MINTED facts — so it can only ATTEST verification, never mint or
      // forge it. Folded into the SAME non-gate update patch (the gate-write allowlist is
      // unchanged); no-op when no signer is configured (default boot unchanged).
      const passportPatch = this.signPassportFor(token)
      // A2.1 — PIN the per-PROJECT delivery destination NOW, in the SAME non-gate patch, so the
      // push-confirm card can SHOW the target BEFORE confirm and a retry reuses the SAME repo. A
      // session whose delivery is ALREADY pinned (a retry/change-request re-running verify) REUSES
      // it (skips re-derivation/collision). Best-effort + NON-GATE: the resolver never throws, and
      // if it returns undefined (no usable connection / anonymous) we just don't pin — the env→mock
      // path / honest refusal at confirmPush is byte-for-byte unchanged. `delivery` is a non-gate
      // SessionPatch column, never a gate write.
      const delivery = await this.resolveDelivery(session)
      const deliveryPatch = delivery ? { delivery } : {}
      // A1: NON-GATE write (status + evidence + passport + delivery; all in SessionPatch, no gate
      // column) — resilient. It chains off the just-persisted verified row; a concurrent chat turn
      // between the recordVerification above and this status flip no longer kills the build.
      // (updateResilient re-reads the fresh version, so it self-heals past `verified.version`.)
      const out = await this.updateResilient(id, { status: 'awaiting_push_confirm', ...evidencePatch, ...passportPatch, ...deliveryPatch })
      // Carry the pinned destination on the AWAITING gate event so the FE shows "→ github.com/…".
      this.emitGate(id, 'push_confirm', 'awaiting', delivery)
      return out
    }
    // No token (real verify did not pass). Persist the structured failure evidence
    // alongside a RETRYABLE `verify_failed` status (NOT a silent reset to 'building'),
    // so a failed run's named failing scenarios survive on GET /sessions/:id and the
    // human can retry (re-runs REAL verification). The recovery signal drives the FE card.
    // A1: NON-GATE write (status + evidence) — resilient.
    const out = await this.updateResilient(id, { status: 'verify_failed', ...evidencePatch })
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

  /**
   * A2.1 — resolve the per-PROJECT delivery destination ({owner,repo}) for a session. RESOLUTION
   * ORDER:
   *   1. `session.delivery` already PINNED (a retry / change-request) → REUSE it verbatim — never
   *      re-derive (that would risk a different repo and break the retry's "same repo" contract).
   *   2. else, if a per-user resolver is wired (`deliveryFor`, i.e. an owned session + real-mode
   *      connections), DERIVE the repo name from the title/idea + collision-probe → {owner,repo}.
   *   3. else undefined (anonymous / no connection / env→mock / NODE_ENV=test) — the caller does NOT
   *      pin and the env→mock path / honest refusal stays byte-for-byte unchanged.
   *
   * NEVER throws (the resolver fails open). Carries NO token — it only NAMES the destination.
   */
  private async resolveDelivery(session: SessionState): Promise<{ owner: string; repo: string } | undefined> {
    if (session.delivery) return session.delivery // pinned — retry/change-request reuse, skip collision
    if (!session.ownerId || !this.s.deliveryFor) return undefined
    try {
      return await this.s.deliveryFor(session.ownerId, session.spec?.title, session.idea)
    } catch {
      return undefined // defensive — the resolver already fails open, but never let it break the run
    }
  }

  async confirmPush(id: string): Promise<SessionState> {
    const cur = await this.s.store.get(id)
    if (!cur) throw new Error(`session ${id} not found`)
    if (cur.status === 'done') throw new AlreadyPushedError()
    if (cur.status !== 'awaiting_push_confirm' && cur.status !== 'push_failed') throw new WrongStatusError('push', cur.status)

    const files = cur.code?.files ?? []
    // Gate 4: mint requires the persisted VerifyToken AND a digest match; throws otherwise.
    const token = mintApprovedPush(cur, files)

    // A2.1 — resolve the per-PROJECT destination. RESOLUTION ORDER: `cur.delivery` (PINNED at
    // awaiting_push_confirm) wins; else derive+collision-probe now (the verify-time pin may have
    // been skipped — pre-existing session, or the resolver failed open then). NEVER throws. This is
    // NOT a store write — the pin persists by folding `delivery` into the done/push_failed patch
    // below (no extra version bump, so the subsequent `cur.version`-locked update stays valid).
    const delivery = await this.resolveDelivery(cur)
    // If we resolved a destination NOW that wasn't already pinned, fold it into every terminal write
    // so it persists + rides the replay (carried on the push_to_github result + done events too).
    const deliveryPatch: { delivery?: { owner: string; repo: string } } = (delivery && !cur.delivery) ? { delivery } : {}

    // TIGHTEN-ONLY per-user destination: when the session owner has a live GitHub connection, push to
    // THAT adapter bound to the per-PROJECT `delivery` (A2.1); else the shared env/mock adapter EXACTLY
    // as today. This only changes WHICH already-gated adapter the unchanged pushToGitHub(ApprovedPush,…)
    // path consumes — never whether/how the push is authorized. Anonymous sessions (no ownerId) and
    // owners without a connection fall through to env→mock.
    const userAdapter = cur.ownerId ? this.s.githubFor?.(cur.ownerId, delivery) : undefined
    const gh = userAdapter ?? this.s.github

    // HONESTY (mock-fallback): in REAL mode — the session is owned AND per-user delivery is wired
    // (`githubFor` present, i.e. not NODE_ENV=test / no connections store) — an owner WITHOUT a
    // usable connection would otherwise fall through to the in-memory MockGitHubAdapter and get a
    // FAKE `github.com/mock/<id>` "success". Refuse instead so the FE shows "connect GitHub". The
    // mock stays legitimate for anonymous/demo/test sessions (no ownerId, or githubFor absent) and
    // a configured real env adapter is never a MockGitHubAdapter, so this only catches the no-real-
    // destination case. Gate-NEUTRAL: Gate-4 already minted the ApprovedPush above; this is about
    // a missing DESTINATION, not authorization. Parked retryable so a later (post-connect) confirm works.
    const realMode = !!cur.ownerId && !!this.s.githubFor
    if (realMode && gh instanceof MockGitHubAdapter) {
      // No usable destination — but still PIN any derived `delivery` so a later (post-connect) retry
      // shows + reuses the same intended repo. Non-gate column; folded into the park write.
      await this.s.store.update(id, { status: 'push_failed', ...deliveryPatch }, cur.version)
      // NO raw-English `error` bus emit here (reviewer MED): confirmPush is an AWAITED route, so
      // the thrown 409 already reaches the clicking user as the LOCALIZED banner + Settings CTA
      // (actionErrorText maps NoGitHubDestinationError). An error event would render its message
      // verbatim as an untranslated transcript bubble — the exact raw-English-row class A2 kills.
      // Other viewers still learn the state from the recovery emit + the push_failed status.
      this.emitRecovery(id, 'push_failed', 'awaiting')
      throw new NoGitHubDestinationError()
    }

    // Push FIRST. Only persist 'done' after a successful push, so a push failure
    // leaves a retryable state (push_failed) and never loses the code.
    this.s.bus.emit({ kind: 'tool_call', tool: 'push_to_github', args: { files: files.length }, agent: 'orchestrator', laneId: 'main', sessionId: id, ts: nextTs() })
    let repoUrl: string
    try {
      repoUrl = await gh.createRepo(id)
      await pushToGitHub(token, gh, files)
    } catch (err) {
      await this.s.store.update(id, { status: 'push_failed', ...deliveryPatch }, cur.version)
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
    // Fold any just-derived `delivery` into the terminal write so the persisted record carries the
    // real repo the push landed in (non-gate column; on replay the gate event already carried it too).
    const session = await this.s.store.update(id, { status: 'done', ...deliveryPatch }, cur.version)
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
