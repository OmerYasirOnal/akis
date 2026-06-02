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
        v.status = e.status === 'started' ? 'started' : e.status === 'failed' ? 'failed' : 'done'
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
        if (step) { step.done = true; step.ok = e.ok }
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
        v.tests = { ...v.tests, testsRun: e.testsRun, passed: e.passed, ran: true }
        break
      case 'code_review':
        // Critic's read-only verdict (last wins across iterations). Automatic, not a gate.
        v.codeReview = { approved: e.approved, findings: e.findings, critical: e.critical, iteration: e.iteration }
        break
      case 'preview':
        // The shipped artifact (e.g. pushed repo URL): a link, not the embedded app.
        v.preview = { ...v.preview, ...(e.url !== undefined ? { artifactUrl: e.url } : {}) }
        break
      case 'preview_status':
        // Live local-preview lifecycle: 'ready' → embed the same-origin /preview/:id app.
        v.preview = {
          ...v.preview,
          ready: e.status === 'ready',
          starting: e.status === 'starting',
          ...(e.url !== undefined ? { url: e.url } : {}),
        }
        break
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
