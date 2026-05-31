import type { Role, ToolName, SessionState } from '@akis/shared'
import type { EventBus } from '../events/bus.js'
import type { LlmProvider, ToolSpec, ChatMessage } from './LlmProvider.js'
import { canUseTool, type PermissionCtx } from '../tools/permission.js'

export interface ToolResult { ok: boolean; result?: unknown; error?: string }

export interface AgentLoopArgs {
  role: Role
  system: string
  laneId: string
  sessionId: string
  session: SessionState
  provider: LlmProvider
  bus: EventBus
  tools: ToolSpec[]
  permissionCtx?: PermissionCtx
  maxTurns?: number
  execute: (tool: ToolName, args: unknown) => Promise<ToolResult>
}

let clock = 0
/** Monotonic counter — deterministic for tests. Runtime injects a real timestamper later. */
const now = () => ++clock

export async function runAgentLoop(a: AgentLoopArgs): Promise<void> {
  const messages: ChatMessage[] = []
  const max = a.maxTurns ?? 20
  for (let turn = 0; turn < max; turn++) {
    const res = await a.provider.chat({ role: a.role, system: a.system, messages, tools: a.tools })
    if (res.text) {
      a.bus.emit({ kind: 'text', text: res.text, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
      messages.push({ role: 'assistant', content: res.text })
    }
    if (!res.toolCalls?.length) return
    for (const call of res.toolCalls) {
      const tool = call.name as ToolName
      a.bus.emit({ kind: 'tool_call', tool, args: call.args, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
      const verdict = canUseTool(a.role, tool, a.session, a.permissionCtx)
      if (!verdict.ok) {
        a.bus.emit({ kind: 'tool_result', tool, ok: false, result: verdict.reason, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
        messages.push({ role: 'tool', toolName: tool, content: `PermissionDenied: ${verdict.reason}` })
        continue
      }
      const out = await a.execute(tool, call.args)
      a.bus.emit({ kind: 'tool_result', tool, ok: out.ok, result: out.result ?? out.error, agent: a.role, laneId: a.laneId, sessionId: a.sessionId, ts: now() })
      messages.push({ role: 'tool', toolName: tool, content: JSON.stringify(out) })
    }
  }
}
