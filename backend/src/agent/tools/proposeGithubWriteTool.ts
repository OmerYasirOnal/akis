import type { RegisteredTool } from './ToolRegistry.js'
import type { SessionStore } from '../../store/SessionStore.js'
import { GITHUB_WRITE_ACTIONS } from '../../gates/externalWriteGate.js'
// REACHABILITY (gate-keeper invariant): this module imports ONLY recordGithubProposal from the gate
// surface — NEVER mintApprovedExternalWrite, executeExternalWrite, or the ApprovedExternalWrite token
// type. The recorder appends a status:'proposed' record and nothing more; there is NO code path from
// this tool to execution (only the human-hit confirm route reaches the executor). Keep it that way.
import { recordGithubProposal } from '../../gates/recordGithubProposal.js'

export interface ProposeGithubWriteDeps {
  /** Captured at registry-build time — NOT a model arg, so the model can never name another session. */
  sessionId: string
  /** The SAME store the propose route uses (DI). The tool appends ONLY via its generic update patch. */
  store: SessionStore
}

/** The action enum advertised to the model — sourced from the SAME frozen GitHub allow-list the gate
 *  enforces, so the schema and the authoritative server-side check can never drift. Advisory only:
 *  the handler re-checks against the gate's own predicate (the schema enum is not the gate). */
const ACTION_ENUM: readonly string[] = [...GITHUB_WRITE_ACTIONS]

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTION_ENUM, description: 'The GitHub external-write action (the MCP write-tool name).' },
    summary: { type: 'string', description: 'One human-readable line for the confirm card.' },
    target: { type: 'object', description: 'WHERE: owner, repo, issue_number|pullNumber, method.' },
    payload: { type: 'object', description: 'WHAT: title/body/state/event/merge_method/labels…' },
  },
  required: ['action', 'summary', 'target', 'payload'],
  additionalProperties: false,
} as const

/**
 * The LLM-callable `propose_github_write` tool: it RECORDS a PROPOSED GitHub write for a human to
 * review and confirm — it EXECUTES NOTHING. It queues a `status:'proposed'` ExternalWriteRecord onto
 * the session via the shared `recordGithubProposal`; the write executes ONLY after an explicit human
 * confirm through the unchanged external-write gate (digest-bound + allow-listed). The model is never
 * autonomous over the outward side effect.
 *
 * GATE-SAFETY: `provider` is hardcoded 'github' inside the recorder (never a model arg); `sessionId`
 * is closed over here (never a model arg). The handler holds NO reference to mint/execute/the token —
 * the strongest it can do is append a proposal. It NEVER throws: the bounded tool loop feeds a handler
 * error back to the model as a string (see toolLoop.ts), so every failure path returns 'Error: <why>'
 * and the loop never crashes.
 */
export function proposeGithubWriteTool(deps: ProposeGithubWriteDeps): RegisteredTool {
  return {
    spec: {
      name: 'propose_github_write',
      description:
        'Record a PROPOSED GitHub write for the human to review and confirm. This does NOT execute — '
        + 'it queues a confirm card. Use for: open/close issue, comment, open/close/merge PR, submit PR review.',
      schema: SCHEMA,
    },
    handler: async (args: unknown): Promise<string> => {
      const a = (args ?? {}) as { action?: unknown; summary?: unknown; target?: unknown; payload?: unknown }
      if (typeof a.action !== 'string' || a.action === '') return "Error: 'action' must be a non-empty string."
      if (typeof a.summary !== 'string' || a.summary === '') return "Error: 'summary' must be a non-empty string."
      const target = isPlainObject(a.target) ? a.target : undefined
      const payload = isPlainObject(a.payload) ? a.payload : undefined
      if (!target) return "Error: 'target' must be an object (WHERE: owner/repo/issue_number|pullNumber/method)."
      if (!payload) return "Error: 'payload' must be an object (WHAT: title/body/state/event/merge_method/labels…)."

      const out = await recordGithubProposal(deps.store, deps.sessionId, { action: a.action, summary: a.summary, target, payload })
      if ('error' in out) return `Error: ${out.error}`
      return `Proposed GitHub ${a.action} (writeId ${out.writeId}). AWAITING HUMAN CONFIRMATION — not executed. Do not assume it happened.`
    },
  }
}

/** A plain object the gate/digest can canonicalize (rejects arrays/null/primitives). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
