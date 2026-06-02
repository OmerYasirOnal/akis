import type { AkisEvent, Role, GateState } from '@akis/shared'

/** One bubble/card in the AKIS conversation thread. Agent turns, gate/verify/preview
 *  cards are mutated in place as the run streams; user/narration/error/done append. */
export interface UserMsg { id: string; kind: 'user'; text: string }
export interface NarrationMsg { id: string; kind: 'narration'; agent: Role; text: string }
export interface ToolLine { tool: string; ok?: boolean }
export interface AgentMsg { id: string; kind: 'agent'; agent: Role; tools: ToolLine[]; notes: string[]; done: boolean; ok?: boolean }
export interface GateMsg { id: string; kind: 'gate'; gate: 'spec_approval' | 'push_confirm'; state: GateState }
export interface VerifyMsg { id: string; kind: 'verify'; testsRun: number; passed: boolean }
/** Read-only critic code-review verdict card (automatic, NOT a human gate). Structured only. */
export interface CodeReviewMsg { id: string; kind: 'code_review'; approved: boolean; findings: number; critical: boolean; iteration: number }
export interface PreviewMsg { id: string; kind: 'preview'; url?: string; ready: boolean }
export interface ErrorMsg { id: string; kind: 'error'; text: string }
export interface DoneMsg { id: string; kind: 'done'; verified: boolean; provider?: string }
export type ChatMessage = UserMsg | NarrationMsg | AgentMsg | GateMsg | VerifyMsg | CodeReviewMsg | PreviewMsg | ErrorMsg | DoneMsg

/**
 * Project the ordered AkisEvent stream into a chat thread. Chronological: agent
 * turns, narration, errors and done append in order; gate/verify/preview are
 * singleton cards updated in place (so the thread shows a gate "awaiting → satisfied"
 * card rather than duplicates). Pure + deterministic (the stream layer dedups by seq).
 */
export function foldChat(idea: string, events: readonly AkisEvent[]): ChatMessage[] {
  const items: ChatMessage[] = []
  if (idea.trim()) items.push({ id: 'user', kind: 'user', text: idea.trim() })

  const openTurn = new Map<string, AgentMsg>()           // by laneId
  const gates = new Map<string, GateMsg>()
  let verifyMsg: VerifyMsg | undefined
  let codeReviewMsg: CodeReviewMsg | undefined
  let previewMsg: PreviewMsg | undefined
  let n = 0

  for (const e of events) {
    const id = `${e.kind}-${n++}`
    switch (e.kind) {
      case 'agent_start': {
        const m: AgentMsg = { id, kind: 'agent', agent: e.agent, tools: [], notes: [], done: false }
        openTurn.set(e.laneId, m); items.push(m)
        break
      }
      case 'agent_end': {
        const m = openTurn.get(e.laneId); if (m) { m.done = true; m.ok = e.ok }
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
        if (g) g.state = e.state
        else { const m: GateMsg = { id, kind: 'gate', gate: e.gate, state: e.state }; gates.set(e.gate, m); items.push(m) }
        break
      }
      case 'verify': {
        if (verifyMsg) { verifyMsg.testsRun = e.testsRun; verifyMsg.passed = e.passed }
        else { verifyMsg = { id, kind: 'verify', testsRun: e.testsRun, passed: e.passed }; items.push(verifyMsg) }
        break
      }
      case 'code_review': {
        // Singleton read-only card updated in place across iterations (last verdict wins).
        if (codeReviewMsg) { codeReviewMsg.approved = e.approved; codeReviewMsg.findings = e.findings; codeReviewMsg.critical = e.critical; codeReviewMsg.iteration = e.iteration }
        else { codeReviewMsg = { id, kind: 'code_review', approved: e.approved, findings: e.findings, critical: e.critical, iteration: e.iteration }; items.push(codeReviewMsg) }
        break
      }
      case 'preview':
      case 'preview_status': {
        const ready = e.kind === 'preview' ? true : e.status === 'ready'
        const url = e.url
        if (!previewMsg) { previewMsg = { id, kind: 'preview', ready, ...(url !== undefined ? { url } : {}) }; items.push(previewMsg) }
        else { previewMsg.ready = ready; if (url !== undefined) previewMsg.url = url }
        break
      }
      case 'error': items.push({ id, kind: 'error', text: e.message }); break
      case 'done': items.push({ id, kind: 'done', verified: e.verified, provider: e.provider }); break
      default: break
    }
  }
  return items
}
