import type { SpecArtifact, SharedContext } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { LlmProvider } from '../../agent/LlmProvider.js'
import { nextTs } from '../../events/clock.js'
import { parseAIJson } from './critic/json-extract.js'
import { renderKnowledge } from './context-prompt.js'

export interface ScribeInput {
  sessionId: string
  laneId: string
  idea: string
  /** Read view of the shared context (F2-AC16). Data only — no gate capability. */
  ctx?: SharedContext
}

export type ScribeOutcome =
  | { type: 'spec'; spec: SpecArtifact }
  | { type: 'clarify'; questions: string[] }

const SCRIBE_SYSTEM = [
  'You are Scribe, the spec author for the AKIS agentic build pipeline.',
  'Turn the user idea into a SMALL, concrete, buildable spec for a single self-contained',
  'web app that runs in the browser (so it can be previewed live) — an MVP, not a platform.',
  'Quality bar:',
  '- title: a clean product name (Title Case). NEVER prefix with "Spec for:".',
  '- Problem: 1–2 sentences on who it is for and what it does.',
  '- User stories: 2–5 concise "As a … I want … so that …" lines.',
  '- Acceptance criteria: testable Given/When/Then bullets the verifier can check by',
  '  driving the UI (concrete selectors/labels/outcomes, no vague wording).',
  '- Out of scope: list what the MVP intentionally omits (auth, backend, persistence…).',
  'Be decisive: pick sensible defaults instead of asking. Reply in the user’s language.',
  'Respond with ONLY a JSON object, no prose, in one of these shapes:',
  '{"kind":"spec","title":"...","body":"# <Title>\\n\\n## Problem\\n...\\n\\n## User stories\\n...\\n\\n## Acceptance criteria\\n- Given ... When ... Then ...\\n\\n## Out of scope\\n- ..."}',
  'or {"kind":"clarify","questions":["..."]}  — only when the idea is truly unintelligible.',
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

    let res
    try {
      res = await this.deps.provider.chat({
        system: SCRIBE_SYSTEM,
        messages: [{ role: 'user', content: input.idea + renderKnowledge(input.ctx) }],
      })
    } catch (err) {
      // A throwing provider (auth/network/model error) must still CLOSE the event
      // frame: emit a failed tool_result + agent_end so the live stream never has
      // an orphaned tool_call, then re-throw (the orchestrator fails the session).
      this.deps.bus.emit({ kind: 'tool_result', tool: 'dispatch_scribe', ok: false, result: { error: errMsg(err) }, agent: 'scribe', laneId, sessionId, ts: nextTs() })
      this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: false, agent: 'scribe', laneId, sessionId, ts: nextTs() })
      throw err
    }

    const { outcome, parsed } = this.parse(res.text ?? '', input.idea)

    // `ok` reflects whether the LLM output actually parsed — a fallback spec is a
    // DEGRADED result, so the event must not claim success (event-stream honesty).
    this.deps.bus.emit({
      kind: 'tool_result', tool: 'dispatch_scribe', ok: parsed,
      result: outcome.type === 'spec' ? { title: outcome.spec.title, parsed } : { clarify: outcome.questions.length, parsed },
      agent: 'scribe', laneId, sessionId, ts: nextTs(),
    })
    this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: parsed, agent: 'scribe', laneId, sessionId, ts: nextTs() })
    return outcome
  }

  private parse(text: string, idea: string): { outcome: ScribeOutcome; parsed: boolean } {
    try {
      const j = parseAIJson<{ kind?: string; title?: string; body?: string; questions?: unknown }>(text)
      if (j.kind === 'clarify' && Array.isArray(j.questions)) {
        return { outcome: { type: 'clarify', questions: j.questions.map(String) }, parsed: true }
      }
      if (typeof j.title === 'string' && typeof j.body === 'string') {
        return { outcome: { type: 'spec', spec: { title: j.title, body: j.body } }, parsed: true }
      }
    } catch {
      /* fall through to a minimal spec so the pipeline is never blocked by a parse miss */
    }
    return { outcome: { type: 'spec', spec: { title: `Spec for: ${idea}`, body: `# ${idea}\n\n${text}`.trim() } }, parsed: false }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
