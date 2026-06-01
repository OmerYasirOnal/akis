import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { TestRunner } from '../../verify/TestRunner.js'
import { mintVerifyToken, type VerifyToken } from '../../verify/VerifyToken.js'
import { nextTs } from '../../events/clock.js'

export interface TraceInput {
  sessionId: string
  laneId: string
  files: RepoFile[]
}

/**
 * Trace — the independent verifier. It is the ONLY role given a TestRunner, so
 * it is the only role that can produce a TestRunResult and therefore the only
 * role that can mint a VerifyToken (Gate 2 by capability). It runs the real
 * runner over the produced files and returns a VerifyToken — or null when the
 * run did not produce a genuine ≥1-test pass (Gate 3, fail-closed).
 *
 * The emitted `verify` event is for the live stream/UX only; it is NOT the
 * source of truth — the returned token is. A forged event cannot grant
 * verification because the orchestrator trusts the token, not the event.
 */
export class TraceAgent {
  constructor(private deps: { bus: EventBus; runner: TestRunner }) {}

  async run(input: TraceInput): Promise<VerifyToken | null> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId, sessionId, ts: nextTs() })

    const result = await this.deps.runner.run(input.files)
    const token = mintVerifyToken(sessionId, result)

    this.deps.bus.emit({ kind: 'verify', testsRun: result.testsRun, passed: result.passed, agent: 'trace', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'agent_end', role: 'trace', ok: token !== null, agent: 'trace', laneId, sessionId, ts: nextTs() })
    return token
  }
}
