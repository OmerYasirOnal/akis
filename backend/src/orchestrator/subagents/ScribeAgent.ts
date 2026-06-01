import type { SpecArtifact } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { LlmProvider } from '../../agent/LlmProvider.js'
import { nextTs } from '../../events/clock.js'
import { parseAIJson } from './critic/json-extract.js'

export interface ScribeInput {
  sessionId: string
  laneId: string
  idea: string
}

export type ScribeOutcome =
  | { type: 'spec'; spec: SpecArtifact }
  | { type: 'clarify'; questions: string[] }

const SCRIBE_SYSTEM = [
  'You are Scribe, the spec author for the AKIS agentic build pipeline.',
  'Turn the user idea into a concrete, buildable spec OR ask for clarification.',
  'Respond with ONLY a JSON object, no prose, in one of these shapes:',
  '{"kind":"spec","title":"...","body":"# ...markdown spec with Problem, Acceptance criteria (Given/When/Then), Out of scope..."}',
  'or {"kind":"clarify","questions":["...","..."]}',
].join('\n')

/**
 * Scribe — idea → spec. LIVE: it calls the injected LLM provider and parses the
 * result into a typed SpecArtifact (CORE-AC1). Emits agent_start, tool_call
 * (dispatch_scribe) and tool_result (CF2) so the run is observable. The mock
 * provider returns deterministic JSON, so tests/keyless runs stay green.
 *
 * `needsClarification` forces the clarify branch without an LLM call (used by the
 * orchestrator's deterministic clarify scenarios/tests).
 */
export class ScribeAgent {
  constructor(private deps: { bus: EventBus; provider: LlmProvider; needsClarification?: boolean }) {}

  async run(input: ScribeInput): Promise<ScribeOutcome> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId, sessionId, ts: nextTs() })

    if (this.deps.needsClarification) {
      const questions = ['Who is the primary user?', 'What is the single most important feature?']
      this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId, sessionId, ts: nextTs() })
      return { type: 'clarify', questions }
    }

    this.deps.bus.emit({ kind: 'tool_call', tool: 'dispatch_scribe', args: { idea: input.idea }, agent: 'scribe', laneId, sessionId, ts: nextTs() })

    const res = await this.deps.provider.chat({
      system: SCRIBE_SYSTEM,
      messages: [{ role: 'user', content: input.idea }],
    })
    const outcome = this.parse(res.text ?? '', input.idea)

    this.deps.bus.emit({
      kind: 'tool_result', tool: 'dispatch_scribe', ok: true,
      result: outcome.type === 'spec' ? { title: outcome.spec.title } : { clarify: outcome.questions.length },
      agent: 'scribe', laneId, sessionId, ts: nextTs(),
    })
    this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId, sessionId, ts: nextTs() })
    return outcome
  }

  private parse(text: string, idea: string): ScribeOutcome {
    try {
      const j = parseAIJson<{ kind?: string; title?: string; body?: string; questions?: unknown }>(text)
      if (j.kind === 'clarify' && Array.isArray(j.questions)) {
        return { type: 'clarify', questions: j.questions.map(String) }
      }
      if (typeof j.title === 'string' && typeof j.body === 'string') {
        return { type: 'spec', spec: { title: j.title, body: j.body } }
      }
    } catch {
      /* fall through to a minimal spec so the pipeline is never blocked by a parse miss */
    }
    return { type: 'spec', spec: { title: `Spec for: ${idea}`, body: `# ${idea}\n\n${text}`.trim() } }
  }
}
