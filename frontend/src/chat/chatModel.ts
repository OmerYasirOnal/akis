import type { AkisEvent, Role, GateState, AgentMetrics } from '@akis/shared'

/** One bubble/card in the AKIS conversation thread. Agent turns, gate/verify/preview
 *  cards are mutated in place as the run streams; user/narration/error/done append. */
export interface UserMsg { id: string; kind: 'user'; text: string }
export interface NarrationMsg { id: string; kind: 'narration'; agent: Role; text: string }
export interface ToolLine { tool: string; ok?: boolean }
export interface AgentMsg { id: string; kind: 'agent'; agent: Role; tools: ToolLine[]; notes: string[]; done: boolean; ok?: boolean; attempts: number; metrics?: AgentMetrics }
// A2.1 — `delivery` ({owner,repo}) is carried ONLY on the push_confirm gate so the card shows the
// per-project destination ("→ github.com/<owner>/<repo>") before the user confirms. Optional —
// an old gate event / the spec gate has none.
export interface GateMsg { id: string; kind: 'gate'; gate: 'spec_approval' | 'push_confirm'; state: GateState; delivery?: { owner: string; repo: string } }
export interface VerifyMsg { id: string; kind: 'verify'; testsRun: number; passed: boolean; demo?: boolean }
/** Read-only critic code-review verdict card (automatic, NOT a human gate). Structured only. */
export interface CodeReviewMsg { id: string; kind: 'code_review'; approved: boolean; findings: number; critical: boolean; iteration: number }
/** A parked run awaiting a HUMAN recovery decision — the inline actionable card (proceed/abandon a
 *  stuck critic, retry a failed verify/push). NOT a structural gate: the server never bypasses
 *  verify/push. A singleton per recovery-kind, flipped awaiting→resolved as the user acts. */
export interface RecoveryMsg { id: string; kind: 'recovery'; recovery: 'critic_resolution' | 'verify_failed' | 'push_failed'; state: 'awaiting' | 'resolved' }
export interface PreviewMsg { id: string; kind: 'preview'; url?: string; ready: boolean; error?: { status: 'failed' | 'unsupported'; reason?: string } }
export interface ErrorMsg { id: string; kind: 'error'; text: string }
export interface DoneMsg { id: string; kind: 'done'; verified: boolean; provider?: string }
export type ChatMessage = UserMsg | NarrationMsg | AgentMsg | GateMsg | VerifyMsg | CodeReviewMsg | RecoveryMsg | PreviewMsg | ErrorMsg | DoneMsg

/**
 * Project ONE run's ordered AkisEvent stream into inline chronological bubbles for its
 * run-block. Agent turns, narration, errors and done append in order; gate/verify/preview
 * are singleton cards updated in place (so the block shows a gate "awaiting → satisfied"
 * card rather than duplicates). Pure + deterministic (the stream layer dedups by seq).
 *
 * NO synthetic user-idea bubble: in the anchored multi-run transcript the idea lives in the
 * chat spine (the run marker carries it / an ordinary user bubble precedes the run-block), so
 * emitting it here would duplicate it. The `narration` bubble is still produced but MARKED so
 * the caller can suppress raw (English) orchestrator prose in the TR UI.
 */
export function foldRunBubbles(events: readonly AkisEvent[]): ChatMessage[] {
  const items: ChatMessage[] = []

  const openTurn = new Map<string, AgentMsg>()           // by laneId (the currently-open turn)
  const byAgent = new Map<Role, AgentMsg>()              // by role — COALESCE an agent's re-runs
  const gates = new Map<string, GateMsg>()
  const recoveries = new Map<string, RecoveryMsg>()  // by recovery-kind (singleton, awaiting→resolved)
  let verifyMsg: VerifyMsg | undefined
  let codeReviewMsg: CodeReviewMsg | undefined
  let previewMsg: PreviewMsg | undefined
  let n = 0

  for (const e of events) {
    const id = `${e.kind}-${n++}`
    switch (e.kind) {
      case 'agent_start': {
        // COALESCE re-runs of the SAME agent (the critic-driven iterate loop fires agent_start for
        // Proto once per round). Instead of stacking N identical "Proto · writing the code" bubbles
        // (the noisy repetition the user flagged), reuse the agent's existing bubble IN PLACE — reset
        // its turn state and bump the attempt count, so it reads as ONE agent that revised N times.
        const prev = byAgent.get(e.agent)
        if (prev) {
          prev.done = false; delete prev.ok; prev.tools = []; prev.notes = []; prev.attempts += 1
          openTurn.set(e.laneId, prev)
        } else {
          const m: AgentMsg = { id, kind: 'agent', agent: e.agent, tools: [], notes: [], done: false, attempts: 1 }
          byAgent.set(e.agent, m); openTurn.set(e.laneId, m); items.push(m)
        }
        break
      }
      case 'agent_end': {
        // Carry the honest per-agent cost (tokens · tools · time) onto the bubble — the transparency
        // badge that used to ride the retired pipeline strip's step. ADDITIVE: an old agent_end with
        // no metrics folds exactly as before (metrics stays undefined → no badge).
        const m = openTurn.get(e.laneId); if (m) { m.done = true; m.ok = e.ok; if (e.metrics) m.metrics = e.metrics }
        openTurn.delete(e.laneId)
        break
      }
      case 'tool_call': { openTurn.get(e.laneId)?.tools.push({ tool: e.tool }); break }
      case 'tool_result': {
        const t = openTurn.get(e.laneId)?.tools.slice().reverse().find(x => x.tool === e.tool && x.ok === undefined)
        if (t) t.ok = e.ok
        break
      }
      case 'text': {
        const m = openTurn.get(e.laneId)
        if (m) m.notes.push(e.text)
        else items.push({ id, kind: 'narration', agent: e.agent, text: e.text })
        break
      }
      case 'gate': {
        const g = gates.get(e.gate)
        // A2.1: carry the per-project `delivery` (push_confirm AWAITING only). On a later satisfied
        // event (no delivery) RETAIN the previously-shown destination rather than clearing it.
        if (g) { g.state = e.state; if (e.delivery) g.delivery = e.delivery }
        else { const m: GateMsg = { id, kind: 'gate', gate: e.gate, state: e.state, ...(e.delivery ? { delivery: e.delivery } : {}) }; gates.set(e.gate, m); items.push(m) }
        break
      }
      case 'verify': {
        if (verifyMsg) { verifyMsg.testsRun = e.testsRun; verifyMsg.passed = e.passed; if (e.demo) verifyMsg.demo = true }
        else { verifyMsg = { id, kind: 'verify', testsRun: e.testsRun, passed: e.passed, ...(e.demo ? { demo: true } : {}) }; items.push(verifyMsg) }
        break
      }
      case 'code_review': {
        // Singleton read-only card updated in place across iterations (last verdict wins).
        if (codeReviewMsg) { codeReviewMsg.approved = e.approved; codeReviewMsg.findings = e.findings; codeReviewMsg.critical = e.critical; codeReviewMsg.iteration = e.iteration }
        else { codeReviewMsg = { id, kind: 'code_review', approved: e.approved, findings: e.findings, critical: e.critical, iteration: e.iteration }; items.push(codeReviewMsg) }
        break
      }
      case 'recovery': {
        // Singleton per recovery-kind, updated in place (awaiting→resolved) so the inline card
        // shows its action while parked and goes quiet once the user acts (the next bubble — a
        // re-run, a verify, a done — carries the outcome). The action surface is now the bubble,
        // not the retired pipeline strip.
        const r = recoveries.get(e.recovery)
        if (r) r.state = e.state
        else { const m: RecoveryMsg = { id, kind: 'recovery', recovery: e.recovery, state: e.state }; recoveries.set(e.recovery, m); items.push(m) }
        break
      }
      case 'preview':
      case 'preview_status': {
        const ready = e.kind === 'preview' ? true : e.status === 'ready'
        const url = e.url
        // A 'failed'/'unsupported' preview_status is a recoverable failure → carry its reason so
        // the thread never silently drops it; a later 'starting'/'ready' frame supersedes it.
        const failed = e.kind === 'preview_status' && (e.status === 'failed' || e.status === 'unsupported')
        const error = failed
          ? { status: e.status as 'failed' | 'unsupported', ...(e.reason ? { reason: e.reason } : {}) }
          : undefined
        if (!previewMsg) { previewMsg = { id, kind: 'preview', ready, ...(url !== undefined ? { url } : {}), ...(error ? { error } : {}) }; items.push(previewMsg) }
        else { previewMsg.ready = ready; if (url !== undefined) previewMsg.url = url; if (error) previewMsg.error = error; else delete previewMsg.error }
        break
      }
      case 'error': items.push({ id, kind: 'error', text: e.message }); break
      case 'done': items.push({ id, kind: 'done', verified: e.verified, provider: e.provider }); break
      default: break
    }
  }
  return items
}

/**
 * @deprecated Transitional alias kept ONLY so the still-old `useLiveChat` caller compiles
 * during the multi-run refactor (next phase rewires it to call `foldRunBubbles` directly).
 * It ignores the legacy `idea` argument — the idea now lives in the chat spine, never as a
 * synthetic bubble. Do NOT add new callers; use `foldRunBubbles(events)`.
 */
export const foldChat = (_idea: string, events: readonly AkisEvent[]): ChatMessage[] => foldRunBubbles(events)
