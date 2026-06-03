import type { SharedContext, AdvisoryPhase } from '@akis/shared'
import type { LlmProvider } from '../LlmProvider.js'
import { callWithTools, type ToolLoopOptions } from '../tools/toolLoop.js'
import type { ToolRegistry } from '../tools/ToolRegistry.js'

/** Where in the pipeline AKIS consults an advisory agent. Both edges are advisory
 *  only — never on the spine between the gates. Canonical list lives in @akis/shared
 *  (ADVISORY_PHASES) so the workflow validator and the builder UI agree. */
export type { AdvisoryPhase }

export interface AdvisoryInput {
  sessionId: string
  phase: AdvisoryPhase
  /** What AKIS is asking this agent to weigh in on. */
  objective: string
  /** Read-only shared context (data only — carries NO gate capability). */
  ctx: SharedContext
  /** The non-gate tools this agent may call (e.g. retrieve_knowledge). */
  tools: ToolRegistry
  /** Observe tool calls for live narration. */
  onTool?: ToolLoopOptions['onTool']
}

export interface AdvisoryNote {
  role: string
  phase: AdvisoryPhase
  text: string
}

/** An advisory (edge) agent: reads context, MAY call non-gate tools, returns a note.
 *  It has NO store/verifier/approval/github dependency, so it cannot reach a gate. */
export interface AdvisoryAgent {
  readonly role: string
  advise(input: AdvisoryInput): Promise<AdvisoryNote>
}

export interface LlmAdvisoryAgentDeps {
  role: string
  provider: LlmProvider
  /** Optional persona text (from a workflow's basePromptVariant). */
  persona?: string
  /** Tool-loop budget for this agent (defaults to callWithTools' own default). */
  maxTurns?: number
}

const DEFAULT_PERSONA = 'Give concise, actionable advice to improve the build. A few sentences, no preamble.'

/**
 * A generic LLM-backed ADVISORY agent — the executable form of a custom (non-core)
 * workflow agent (CF4). It reads the shared context, MAY call non-gate tools (e.g.
 * retrieve_knowledge) through the injected registry, and returns a note.
 *
 * By construction it holds NO store / verifier / approval-authority / github
 * dependency, so it CANNOT reach any of the 4 structural gates — it can only advise.
 * Flexibility lives at the edges; the verified spine stays untouched.
 */
export class LlmAdvisoryAgent implements AdvisoryAgent {
  readonly role: string
  constructor(private deps: LlmAdvisoryAgentDeps) {
    this.role = deps.role
  }

  async advise(input: AdvisoryInput): Promise<AdvisoryNote> {
    const system = [
      `You are "${this.deps.role}", an ADVISORY agent in the AKIS agentic build pipeline.`,
      this.deps.persona ?? DEFAULT_PERSONA,
      'You have NO authority to approve specs, run tests, verify, or ship — you ONLY advise.',
      'If it helps, call retrieve_knowledge to ground your advice in prior project context.',
    ].join('\n')
    const user = `Phase: ${input.phase}\nObjective: ${input.objective}\n\n${renderCtx(input.ctx)}`

    const opts: ToolLoopOptions = {}
    if (input.onTool) opts.onTool = input.onTool
    if (this.deps.maxTurns !== undefined) opts.maxTurns = this.deps.maxTurns

    const res = await callWithTools(this.deps.provider, { system, messages: [{ role: 'user', content: user }] }, input.tools, opts)
    return { role: this.deps.role, phase: input.phase, text: (res.text ?? '').trim() || '(no advice)' }
  }
}

/** A compact, read-only rendering of the shared context for an advisory prompt. */
function renderCtx(ctx: SharedContext): string {
  const lines = [`Idea: ${ctx.session.idea}`]
  if (ctx.session.spec) lines.push(`Spec: ${ctx.session.spec.title}`)
  if (ctx.knowledge.length) lines.push(`Knowledge available: ${ctx.knowledge.length} chunk(s).`)
  const notes = ctx.scratchpad.notes
  if (notes.length) lines.push(`Recent notes: ${notes.slice(-3).join(' | ')}`)
  return lines.join('\n')
}
