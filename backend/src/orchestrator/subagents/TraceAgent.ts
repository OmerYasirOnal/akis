import type { VerifyToken, TestEvidence, SpecArtifact } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { Verifier } from '../../verify/verifier.js'
import { nextTs } from '../../events/clock.js'
import { buildAgentMetrics } from '../../agent/metrics.js'

export interface TraceInput {
  sessionId: string
  laneId: string
  files: RepoFile[]
  /** The run's approved spec (PR2) — its acceptance criteria derive the boot-smoke probes.
   *  Data only: it shapes what is PROBED, never whether a probe passed (mint unchanged). */
  spec?: SpecArtifact
}

/**
 * Trace's verification outcome. `token` is the GATE TRUTH (null ⇔ no genuine pass).
 * `evidence` is the ADDITIVE, NON-GATE structured detail the verifier computed
 * (scenarios + counts + durationMs + structured failure) — observability only; the
 * orchestrator persists it on the normal (non-gate) update path. Absent only if the
 * runner reported none.
 */
export interface TraceResult {
  token: VerifyToken | null
  evidence?: TestEvidence
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

  async run(input: TraceInput): Promise<TraceResult> {
    const { sessionId, laneId } = input
    // Real wall-clock start (Date.now, not the event counter). Trace runs the verifier,
    // NOT an LLM (the canonical "time present, usage absent" badge), so usage is omitted.
    const startedAt = Date.now()
    let toolCalls = 0
    this.deps.bus.emit({ kind: 'agent_start', role: 'trace', agent: 'trace', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'tool_call', tool: 'run_tests', args: { files: input.files.length }, agent: 'trace', laneId, sessionId, ts: nextTs() })
    toolCalls++

    // ADDITIVE: capture the structured evidence the verifier reports via the side
    // channel. The token below is the UNCHANGED gate truth — minting reads only the
    // branded result, never this evidence, so the captured value cannot affect it.
    let evidence: TestEvidence | undefined
    const token = await this.deps.verifier.verify(sessionId, input.files, { onEvidence: e => { evidence = e }, ...(input.spec ? { spec: input.spec } : {}) })

    this.deps.bus.emit({ kind: 'tool_result', tool: 'run_tests', ok: token !== null, result: { testsRun: token?.testsRun ?? 0, passed: token !== null }, agent: 'trace', laneId, sessionId, ts: nextTs() })
    // Stamp `demo:true` ONLY when this verifier runs the mock/injected runner (simulated
    // verification). It is informational metadata about the runner, never about the outcome —
    // the token above is the unchanged source of truth. Spread it so a live run emits a
    // byte-identical verify event with NO `demo` field (never `demo:false` noise).
    this.deps.bus.emit({ kind: 'verify', testsRun: token?.testsRun ?? 0, passed: token !== null, ...(this.deps.verifier.demo ? { demo: true } : {}), agent: 'trace', laneId, sessionId, ts: nextTs() })
    // Trace makes NO LLM call → usage absent ("—" in the UI), but real durationMs + toolCalls.
    const metrics = buildAgentMetrics(undefined, startedAt, toolCalls)
    this.deps.bus.emit({ kind: 'agent_end', role: 'trace', ok: token !== null, ...(metrics ? { metrics } : {}), agent: 'trace', laneId, sessionId, ts: nextTs() })
    // The SAME demo source as the verify event, but stamped onto the PERSISTED evidence —
    // the event lives in a capped ring buffer and can be evicted on long sessions; the
    // evidence survives, so a simulated run stays labeled forever (review #113).
    const stamped = evidence && this.deps.verifier.demo ? { ...evidence, demo: true } : evidence
    return { token, ...(stamped ? { evidence: stamped } : {}) }
  }
}
