import type { AkisEvent } from '@akis/shared'
import type { SessionView, AgentLane, StepNode, SessionStatus } from './types.js'

export function emptyView(sessionId: string): SessionView {
  return {
    sessionId,
    status: 'unknown',
    lanes: [],
    gates: {},
    tests: { testsRun: 0, passed: false, ran: false },
    preview: { ready: false },
    errors: [],
  }
}

/**
 * Pure projection of a session's AkisEvent stream into the live view-model — the
 * same idea as the backend scratchpad, extended with a per-agent/lane step tree for
 * the UI. Deterministic and side-effect free (same input → same output). It assumes
 * a deduped, seq-ordered event list; DEDUP IS THE STREAM LAYER'S JOB (useLiveSession
 * keys events by seq), so replays/reconnects/resets never double-count here.
 */
export function foldSessionView(sessionId: string, events: readonly AkisEvent[]): SessionView {
  const v = emptyView(sessionId)
  const laneMap = new Map<string, AgentLane>()
  // The currently-open step per lane, so tool_call/result/text/end attach correctly.
  const openStep = new Map<string, StepNode>()

  const lane = (laneId: string): AgentLane => {
    let l = laneMap.get(laneId)
    if (!l) { l = { laneId, steps: [] }; laneMap.set(laneId, l) }
    return l
  }

  for (const e of events) {
    switch (e.kind) {
      case 'session':
        // `cancelled` is a clean TERMINAL abandon (Stop/Cancel) — distinct from a failure or a
        // ship — so the run reads as stopped (not "shipped") and the Stop control hides.
        v.status = e.status === 'started' ? 'started' : e.status === 'failed' ? 'failed' : e.status === 'cancelled' ? 'cancelled' : 'done'
        break
      case 'agent_start': {
        const step: StepNode = { agent: e.agent, done: false, tools: [], notes: [] }
        lane(e.laneId).steps.push(step)
        openStep.set(e.laneId, step)
        if (v.status === 'started' || v.status === 'unknown') v.status = 'running'
        break
      }
      case 'agent_end': {
        const step = openStep.get(e.laneId)
        // ADDITIVE: carry the agent's honest cost metrics if present. An OLD event (no
        // metrics) leaves step.metrics undefined — today's behavior. This single line makes
        // BOTH live AND history (replayed /log) carry metrics, since both fold through here.
        if (step) { step.done = true; step.ok = e.ok; if (e.metrics) step.metrics = e.metrics }
        openStep.delete(e.laneId)
        break
      }
      case 'tool_call': {
        const step = openStep.get(e.laneId)
        if (step) step.tools.push({ tool: e.tool, args: e.args })
        break
      }
      case 'tool_result': {
        const step = openStep.get(e.laneId)
        // Match the most recent pending tool of the same name (else append).
        const pending = step?.tools.slice().reverse().find(t => t.tool === e.tool && t.ok === undefined)
        if (pending) { pending.ok = e.ok; pending.result = e.result }
        else if (step) step.tools.push({ tool: e.tool, ok: e.ok, result: e.result })
        // Only surface a tool failure that we could attach to a step — never an
        // orphan error with no visible tool (would be inconsistent). With seq-ordered
        // input a tool_result always follows its agent_start, so this stays consistent;
        // standalone failures still surface via `error` events.
        if (!e.ok && (pending || step)) v.errors.push(describeFailure(e.tool, e.result))
        break
      }
      case 'text': {
        const step = openStep.get(e.laneId)
        if (step) step.notes.push(e.text)
        break
      }
      case 'gate':
        if (e.gate === 'spec_approval') v.gates.specApproval = { gate: 'spec_approval', state: e.state }
        else v.gates.pushConfirm = { gate: 'push_confirm', state: e.state }
        break
      case 'verify':
        // Carry the optional `demo` annotation (P1-CORE-1): true ⇔ the result came from the
        // mock/injected runner (simulated verification), so the UI marks it at the result.
        v.tests = { ...v.tests, testsRun: e.testsRun, passed: e.passed, ran: true, ...(e.demo ? { demo: true } : {}) }
        break
      case 'code_review':
        // Critic's read-only verdict (last wins across iterations). Automatic, not a gate.
        v.codeReview = { approved: e.approved, findings: e.findings, critical: e.critical, iteration: e.iteration }
        break
      case 'recovery':
        // A recoverable run state → an ACTION card (not a silent amber dot). Last wins, so a
        // `resolved` frame clears the awaiting card after the human acted (idempotent on replay).
        if (e.recovery === 'critic_resolution') v.recovery = { critic: e.state }
        else if (e.recovery === 'push_failed') v.pushFailed = { retry: e.state }
        else v.verifyFailed = { retry: e.state }
        break
      case 'preview':
        // The shipped artifact (e.g. pushed repo URL): a link, not the embedded app.
        v.preview = { ...v.preview, ...(e.url !== undefined ? { artifactUrl: e.url } : {}) }
        break
      case 'preview_status': {
        // Live local-preview lifecycle: 'ready' → embed the same-origin /preview/:id app.
        // `demo` (P1-CORE-1) sticks once seen so the badge persists across lifecycle frames.
        // A 'failed'/'unsupported' frame is a RECOVERABLE failure → surface its reason (never a
        // silent collapse to the empty state); a 'starting'/'ready' frame supersedes it (a retry's
        // spinner/iframe clears the prior failure).
        const failed = e.status === 'failed' || e.status === 'unsupported'
        // Drop any prior `url` AND `error` from the spread. Only a 'ready' frame yields a live,
        // embeddable /preview/:id/ url, so a non-ready frame (starting/failed/unsupported/stopped)
        // must NOT keep a torn-down preview embeddable — else the stale iframe shadows the spinner
        // (on a re-run's 'starting') or the error card + Retry (on a re-run that 'failed'), silently
        // re-introducing the very dead-end this surfacing exists to kill. 'ready' re-adds the fresh
        // url; a 'starting'/'ready' frame clears `error` (the retry supersedes the failure); a
        // failure frame re-adds `error`.
        const { error: _prevError, url: _prevUrl, ...prevPreview } = v.preview
        void _prevError; void _prevUrl
        v.preview = {
          ...prevPreview,
          ready: e.status === 'ready',
          starting: e.status === 'starting',
          stopped: e.status === 'stopped', // recomputed each frame → a re-run's starting/ready clears it
          ...(e.status === 'ready' && e.url !== undefined ? { url: e.url } : {}),
          ...(e.demo ? { demo: true } : {}),
          ...(failed ? { error: { status: e.status as 'failed' | 'unsupported', ...(e.reason ? { reason: e.reason } : {}) } } : {}),
        }
        break
      }
      case 'test_stats':
        // Rich BDD/E2E telemetry for the dashboard (verify stays the gate's truth).
        v.tests = { ...v.tests, ran: true, scenariosBuilt: e.built, scenariosRunning: e.running }
        break
      case 'test_progress':
        if (e.running !== undefined) v.tests = { ...v.tests, ran: true, scenariosRunning: e.running }
        break
      case 'error':
        v.errors.push(e.message)
        break
      case 'done':
        v.status = 'done'
        v.provider = e.provider
        v.verified = e.verified
        break
      default:
        break
    }
  }

  v.lanes = [...laneMap.values()]
  return v
}

function describeFailure(tool: string, result: unknown): string {
  const err = result && typeof result === 'object' && 'error' in result ? String((result as { error: unknown }).error) : ''
  return err ? `${tool}: ${err}` : `${tool}: failed`
}

const _statuses: SessionStatus[] = ['started', 'running', 'done', 'failed', 'unknown']
void _statuses
