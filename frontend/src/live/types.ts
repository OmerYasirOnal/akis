import type { AkisEvent, Role, GateState } from '@akis/shared'

/** An event with its per-session transport seq (the resumable cursor). The FE keys
 *  events by seq so replays/reconnects/resets dedup — never lost or duplicated. */
export interface SeqEvent {
  seq: number
  event: AkisEvent
}

/** A tool use under an agent step (dispatch_x, run_tests, push_to_github). */
export interface ToolStep {
  tool: string
  args?: unknown
  ok?: boolean        // undefined while pending; set on tool_result
  result?: unknown
}

/** One agent activation on a lane (agent_start … agent_end), with its tool uses. */
export interface StepNode {
  agent: Role
  done: boolean
  ok?: boolean        // set on agent_end
  tools: ToolStep[]
  notes: string[]     // `text` narration attributed to this agent
}

export interface AgentLane {
  laneId: string
  steps: StepNode[]
}

export interface GateCard {
  gate: 'spec_approval' | 'push_confirm'
  state: GateState
}

/** Verification / test stats. `testsRun`/`passed` come from the `verify` event today;
 *  the richer Playwright/Cucumber fields fill in when the preview/test-env backend lands. */
export interface TestStats {
  testsRun: number
  passed: boolean
  ran: boolean        // a verify event was seen
  /** The verify result was produced by the mock/injected runner (simulated verification),
   *  not a real ≥1-test pass. Carried by the `verify` event's optional `demo` flag (P1-CORE-1).
   *  Drives the "verification simulated" badge ON the verify gate card. Absent on a live run. */
  demo?: boolean
  scenariosBuilt?: number
  scenariosRunning?: number
  p95Ms?: number
}

export interface PreviewState {
  /** The same-origin /preview/:id/ path of the locally-RUNNING app (embedded in the iframe). */
  url?: string
  /** The shipped artifact location (e.g. the pushed repo URL) — shown as a link, not embedded. */
  artifactUrl?: string
  /** The running app is up (preview_status 'ready'). */
  ready: boolean
  /** A local run is being started (install/boot) — show a spinner. */
  starting?: boolean
  /** The boot is in demo mode (mock provider/verification) — the embedded "running app" is a
   *  demo, not a real-verified build. Carried by the `preview_status` event's `demo` flag
   *  (P1-CORE-1). Drives the badge on the PreviewPanel. Absent on a live boot. */
  demo?: boolean
  /** A terminal preview-boot FAILURE the human can recover from (NOT a silent dead-end): the
   *  local run failed to start ('failed') or this app can't be previewed locally ('unsupported').
   *  Carried by the `preview_status` event; `reason` is the backend's short human label. Cleared
   *  on the next 'starting'/'ready' frame (a retry's spinner/iframe supersedes the failure). */
  error?: { status: 'failed' | 'unsupported'; reason?: string }
}

/** The critic's READ-ONLY code-review verdict (a status card, NOT a human gate).
 *  Structured only — booleans + bounded counts; never carries free-form prose. */
export interface CodeReviewState {
  approved: boolean
  findings: number
  critical: boolean
  iteration: number
}

/**
 * A RECOVERABLE run state the human can act on (from the `recovery` event) so a parked
 * run is an ACTION card, not a silent amber dot. NOT a structural gate — acting on it
 * never bypasses verify/push (see the backend `recovery` event doc).
 *   - critic_resolution: the automatic critic did not approve + iterate budget exhausted →
 *     the human chooses proceed (continue the pipeline) or abandon (cancel).
 *   - verify_failed: real verification produced no token → the human retries (re-runs tests).
 * `resolved` ⇔ the human already chose, so a replayed stream shows the card is done.
 */
export interface RecoveryState {
  critic: 'awaiting' | 'resolved'
}
export interface VerifyFailedState {
  retry: 'awaiting' | 'resolved'
}
/**
 * A VERIFIED run whose push to GitHub failed (retryable). NOT a structural gate: the retry
 * re-runs the GATED confirmPush (Gate 4 still mints an ApprovedPush from the VerifyToken), so
 * this surfaces a retry affordance WITHOUT bypassing the push gate. `resolved` once the push
 * later succeeds (idempotent on replay).
 */
export interface PushFailedState {
  retry: 'awaiting' | 'resolved'
}

export type SessionStatus = 'started' | 'running' | 'done' | 'failed' | 'cancelled' | 'unknown'

/** A selectable saved workflow preset (id + display name) for the build composer. */
export interface WorkflowOption { id: string; name: string }

/** The full live view of a session — a pure projection of its AkisEvent stream. */
export interface SessionView {
  sessionId: string
  status: SessionStatus
  lanes: AgentLane[]
  gates: { specApproval?: GateCard; pushConfirm?: GateCard }
  tests: TestStats
  preview: PreviewState
  errors: string[]
  /** Latest critic code-review verdict (read-only status card); undefined until reviewed. */
  codeReview?: CodeReviewState
  /** A recoverable critic-resolution state (proceed/abandon); undefined until the run parks. */
  recovery?: RecoveryState
  /** A recoverable verify-failed state (retry); undefined until a real verify fails. */
  verifyFailed?: VerifyFailedState
  /** A recoverable push-failed state (retry); undefined until a verified run's push fails. */
  pushFailed?: PushFailedState
  provider?: string
  verified?: boolean
  /**
   * TRANSPORT state (NOT event-derived): the live SSE stream dropped and the resumable
   * EventSource is reconnecting (via Last-Event-ID / seq, so no events double-count). The
   * hook OVERLAYS this after folding — `foldSessionView` stays a pure projection of events.
   * Drives a subtle "connection lost — reconnecting" banner (distinct from a terminal
   * failure) so a dropped stream stops pulsing forever and the run reads as recoverable.
   */
  connectionLost?: boolean
}
