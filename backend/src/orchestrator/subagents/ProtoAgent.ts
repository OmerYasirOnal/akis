import type { EventBus } from '../../events/bus.js'
import type { RepoFile } from '../../di/MockGitHubAdapter.js'
import type { ApprovedSpec } from '../../gates/specGate.js'
import type { LlmProvider } from '../../agent/LlmProvider.js'
import { nextTs } from '../../events/clock.js'
import { parseAIJson } from './critic/json-extract.js'

export interface ProtoInput {
  sessionId: string
  laneId: string
  /** Gate 1: Proto cannot run without an ApprovedSpec token (only approve() mints it). */
  approved: ApprovedSpec
  feedback?: string
}

const PROTO_SYSTEM = [
  'You are Proto, the code author for the AKIS agentic build pipeline.',
  'Given an approved spec, produce the minimal working code that satisfies it.',
  'Respond with ONLY a JSON object, no prose:',
  '{"files":[{"filePath":"index.ts","content":"...full file contents..."}, ...]}',
  'Keep files small and focused. Do NOT include tests (the verifier writes those).',
].join('\n')

/**
 * Proto — spec → code. LIVE: it calls the injected LLM provider with the approved
 * spec and parses the result into typed RepoFile[] (CORE-AC1). It REQUIRES an
 * ApprovedSpec token, so code-write cannot run without approval (Gate 1). Emits
 * agent_start, tool_call (dispatch_proto) + tool_result (CF2). Proto returns
 * files only — the push happens once behind the push gate.
 */
export class ProtoAgent {
  constructor(private deps: { bus: EventBus; provider: LlmProvider }) {}

  async run(input: ProtoInput): Promise<{ files: RepoFile[] }> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'proto', agent: 'proto', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'tool_call', tool: 'dispatch_proto', args: { spec: input.approved.spec.title, feedback: input.feedback ?? null }, agent: 'proto', laneId, sessionId, ts: nextTs() })

    const user = [
      `SPEC: ${input.approved.spec.title}`,
      input.approved.spec.body,
      input.feedback ? `\nADDRESS THIS REVIEW FEEDBACK:\n${input.feedback}` : '',
    ].join('\n')

    let res
    try {
      res = await this.deps.provider.chat({ system: PROTO_SYSTEM, messages: [{ role: 'user', content: user }] })
    } catch (err) {
      // A throwing provider must still CLOSE the event frame (failed tool_result +
      // agent_end) so the live stream never has an orphaned tool_call, then re-throw.
      this.deps.bus.emit({ kind: 'tool_result', tool: 'dispatch_proto', ok: false, result: { error: errMsg(err) }, agent: 'proto', laneId, sessionId, ts: nextTs() })
      this.deps.bus.emit({ kind: 'agent_end', role: 'proto', ok: false, agent: 'proto', laneId, sessionId, ts: nextTs() })
      throw err
    }

    const { files, parsed } = this.parse(res.text ?? '', input.approved.spec.title)

    // `ok` reflects whether the LLM output parsed into real files — the placeholder
    // fallback is a DEGRADED result, so the event must not claim success.
    this.deps.bus.emit({ kind: 'tool_result', tool: 'dispatch_proto', ok: parsed, result: { files: files.length, parsed }, agent: 'proto', laneId, sessionId, ts: nextTs() })
    this.deps.bus.emit({ kind: 'agent_end', role: 'proto', ok: parsed, agent: 'proto', laneId, sessionId, ts: nextTs() })
    return { files }
  }

  private parse(text: string, title: string): { files: RepoFile[]; parsed: boolean } {
    try {
      const j = parseAIJson<{ files?: unknown }>(text)
      if (Array.isArray(j.files)) {
        const files = j.files
          .map(f => f as { filePath?: unknown; content?: unknown })
          .filter(f => typeof f.filePath === 'string' && typeof f.content === 'string')
          .map(f => ({ filePath: f.filePath as string, content: f.content as string }))
        if (files.length) return { files, parsed: true }
      }
    } catch {
      /* fall through */
    }
    // Never block the pipeline on a parse miss; emit a single placeholder file.
    return { files: [{ filePath: 'index.ts', content: `// ${title}\nexport const app = (): string => 'ok'\n` }], parsed: false }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
