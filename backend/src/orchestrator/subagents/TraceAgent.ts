import type { VerifyToken } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { Verifier } from '../../verify/verifier.js'
import { nextTs } from '../../events/clock.js'

export interface TraceInput {
  sessionId: string
  laneId: string
  files: RepoFile[]
}

/**
 * Trace — the independent verifier. It holds a `Verifier` capability (the only
 * way to produce a VerifyToken; the mint is module-private to verifier.ts, so no
 * producer can import it). It runs the verifier over the produced files; the
 * returned token binds the runner-computed digest — or null when the run did not
 * produce a genuine ≥1-test pass (Gate 3, fail-closed).
 *
 * Emits agent_start, tool_call (run_tests) + tool_result so the verification is
 * observable in the live stream (CF2). The emitted `verify` event and the
 * returned token are the source of truth; the tool_* events are narration only.
 */
export class TraceAgent {
  constructor(private deps: { bus: EventBus; verifier: Verifier }) {}

  async run(input: TraceInput): Promise<VerifyToken | null> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'tool_call', tool: 'run_tests', args: { files: input.files.length }, agent: 'trace', laneId, sessionId, ts: nextTs() })

    const token = await this.deps.verifier.verify(sessionId, input.files)

    this.deps.bus.emit({ kind: 'tool_result', tool: 'run_tests', ok: token !== null, result: { testsRun: token?.testsRun ?? 0, passed: token !== null }, agent: 'trace', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'verify', testsRun: token?.testsRun ?? 0, passed: token !== null, agent: 'trace', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'agent_end', role: 'trace', ok: token !== null, agent: 'trace', laneId, sessionId, ts: nextTs() })
    return token
  }
}
