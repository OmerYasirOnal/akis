import type { LlmProvider } from '../../agent/LlmProvider.js'
import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import { nextTs } from '../../events/clock.js'
import { getKnobs } from './knobs.js'

export interface TraceInput {
  sessionId: string
  laneId: string
  files: RepoFile[]
}

export interface TraceResult { testsRun: number; passed: boolean }

/**
 * Trace — the independent verifier. It is the ONLY role permitted to run tests
 * (enforced by the permission layer). It generates tests for the code and runs
 * them, then emits a `verify` event with the REAL number of tests run and the
 * pass/fail result. In the MVP (mock) the count comes from `mockTraceTestCount`
 * (default 1); a count of 0 is the vacuous-green case → not verified.
 */
export class TraceAgent {
  constructor(private deps: { provider: LlmProvider; bus: EventBus }) {}

  async run(input: TraceInput): Promise<TraceResult> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId, sessionId, ts: nextTs() })

    const knobs = getKnobs(this.deps.provider)
    const testsRun = knobs.mockTraceTestCount ?? 1
    // A real test run only "passes" if at least one test actually executed.
    const passed = testsRun > 0

    this.deps.bus.emit({ kind: 'verify', testsRun, passed, agent: 'trace', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'agent_end', role: 'trace', ok: passed, agent: 'trace', laneId, sessionId, ts: nextTs() })
    return { testsRun, passed }
  }
}
