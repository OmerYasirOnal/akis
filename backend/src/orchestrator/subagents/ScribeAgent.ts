import type { SpecArtifact, SharedContext } from '@akis/shared'
import type { EventBus } from '../../events/bus.js'
import type { ChatResult, LlmProvider } from '../../agent/LlmProvider.js'
import { nextTs } from '../../events/clock.js'
import { parseAIJson } from './critic/json-extract.js'
import { renderKnowledge } from './context-prompt.js'
import { chatWithLiveNotes } from './streamNotes.js'
import type { KnowledgePort } from '../../knowledge/KnowledgePort.js'
import { buildAdvisoryTools } from '../../agent/tools/advisoryTools.js'
import { callWithTools } from '../../agent/tools/toolLoop.js'

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

export const SCRIBE_SYSTEM = [
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

/** Scribe gains a `retrieve_knowledge` line ONLY when RAG is on, so the RAG-off
 *  system prompt stays byte-identical to today. */
const SCRIBE_RAG_HINT =
  'If it helps ground the spec, call retrieve_knowledge to pull relevant prior project context before drafting.'

/**
 * Scribe — idea → spec. LIVE: it calls the injected LLM provider and parses the
 * result into a typed SpecArtifact (CORE-AC1). Emits agent_start, tool_call
 * (dispatch_scribe) and tool_result (CF2) so the run is observable. The mock
 * provider returns deterministic JSON, so tests/keyless runs stay green.
 *
 * RAG ON (P3-AGENT-2): when `ragEnabled` + a `knowledge` port are wired, Scribe
 * composes the spec through the EXISTING bounded tool loop (callWithTools) with
 * ONLY the read-only `retrieve_knowledge` tool in scope — the same loop + same
 * single allow-list choke point (buildAdvisoryTools) the advisory agents use. So
 * Scribe pulls grounding ON DEMAND, and each retrieve_knowledge use surfaces as a
 * real tool_call/tool_result on the live stream. RAG OFF (default) → the loop is
 * never built and control flow is the byte-identical single-shot dispatch.
 *
 * Scribe is a PRODUCER: the tool scope can NEVER include a gate capability —
 * buildAdvisoryTools only ever wires read-only tools and the loop's registry holds
 * no gate authority, so this path cannot reach the verifier/run_tests/push/token mint.
 *
 * `needsClarification` forces the clarify branch without an LLM call (used by the
 * orchestrator's deterministic clarify scenarios/tests).
 */
export class ScribeAgent {
  /** The base system prompt this Scribe sends. Defaults to SCRIBE_SYSTEM, so an
   *  agent built without a `systemPrompt` dep is byte-identical to today. The DI
   *  layer injects the skill-composed prompt here (P3-AGENT-1). */
  private readonly base: string

  constructor(
    private deps: {
      bus: EventBus
      provider: LlmProvider
      needsClarification?: boolean
      /** Read-only RAG port. Only consulted when `ragEnabled` is true. */
      knowledge?: KnowledgePort
      /** When true (RAG on), compose via the bounded retrieve_knowledge tool loop. */
      ragEnabled?: boolean
      /** Skill-composed base system prompt (P3-AGENT-1). Omitted ⇒ SCRIBE_SYSTEM,
       *  so a no-skills build sends the byte-identical prompt of today. */
      systemPrompt?: string
    },
  ) {
    this.base = deps.systemPrompt ?? SCRIBE_SYSTEM
  }

  async run(input: ScribeInput): Promise<ScribeOutcome> {
    const { sessionId, laneId } = input
    this.deps.bus.emit({ kind: 'agent_start', role: 'scribe', agent: 'scribe', laneId, sessionId, ts: nextTs() })

    if (this.deps.needsClarification) {
      const questions = ['Who is the primary user?', 'What is the single most important feature?']
      this.deps.bus.emit({ kind: 'agent_end', role: 'scribe', ok: true, agent: 'scribe', laneId, sessionId, ts: nextTs() })
      return { type: 'clarify', questions }
    }

    this.deps.bus.emit({ kind: 'tool_call', tool: 'dispatch_scribe', args: { idea: input.idea }, agent: 'scribe', laneId, sessionId, ts: nextTs() })

    let res: ChatResult
    try {
      res = await this.compose(input)
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

  /**
   * Produce Scribe's raw model output. RAG OFF (default): a single provider.chat
   * dispatch — byte-identical to the original control flow (same system prompt,
   * same single user message, no tools). RAG ON: the SAME prompt is driven through
   * the existing bounded tool loop with ONLY retrieve_knowledge in scope, so the
   * model can pull grounding on demand. Each tool use is narrated as a real
   * tool_call/tool_result on the bus.
   */
  private async compose(input: ScribeInput): Promise<ChatResult> {
    const { sessionId, laneId } = input
    const userMsg = input.idea + renderKnowledge(input.ctx)

    if (!this.deps.ragEnabled || !this.deps.knowledge) {
      // RAG OFF — single-shot dispatch (no tools advertised). `this.base` is SCRIBE_SYSTEM
      // unless the DI layer injected a skill-composed prompt. Stream live notes so the spec
      // visibly forms (same result as chat()).
      return chatWithLiveNotes(this.deps, { system: this.base, messages: [{ role: 'user', content: userMsg }], maxTokens: 8192 }, { agent: 'scribe', laneId, sessionId })
    }

    // RAG ON — reuse the advisory choke point + bounded loop. The registry holds
    // ONLY retrieve_knowledge (read-only, zero gate authority); the loop's turn cap
    // bounds it. The system prompt gains the retrieve_knowledge hint ONLY here, so
    // the RAG-off prompt above is untouched. Skill injection (if any) is already
    // folded into `this.base`, so it flows into BOTH branches.
    const tools = buildAdvisoryTools(new Set(['retrieve_knowledge']), { knowledge: this.deps.knowledge, sessionId })
    const system = `${this.base}\n${SCRIBE_RAG_HINT}`
    return callWithTools(
      this.deps.provider,
      { system, messages: [{ role: 'user', content: userMsg }] },
      tools,
      {
        onTool: (call, result) => {
          // Surface each retrieve_knowledge use as a real tool_call/tool_result so
          // the live UI shows the grounding steps. ok=true: a tool result string is
          // always returned (errors degrade to an error string, never a throw).
          this.deps.bus.emit({ kind: 'tool_call', tool: 'retrieve_knowledge', args: call.args, agent: 'scribe', laneId, sessionId, ts: nextTs() })
          this.deps.bus.emit({ kind: 'tool_result', tool: 'retrieve_knowledge', ok: true, result: { chars: result.length }, agent: 'scribe', laneId, sessionId, ts: nextTs() })
        },
      },
    )
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
