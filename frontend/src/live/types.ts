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
}

export type SessionStatus = 'started' | 'running' | 'done' | 'failed' | 'unknown'

/** The full live view of a session — a pure projection of its AkisEvent stream. */
export interface SessionView {
  sessionId: string
  status: SessionStatus
  lanes: AgentLane[]
  gates: { specApproval?: GateCard; pushConfirm?: GateCard }
  tests: TestStats
  preview: PreviewState
  errors: string[]
  provider?: string
  verified?: boolean
}
