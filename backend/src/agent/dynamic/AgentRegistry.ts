import { isGateTool, type AdvisoryPhase } from '@akis/shared'
import type { AdvisoryAgent } from './AdvisoryAgent.js'

interface Entry {
  agent: AdvisoryAgent
  capabilities: ReadonlySet<string>
  /** The single edge this agent is pinned to; undefined ⇒ dispatched at EVERY edge. */
  phase?: AdvisoryPhase
}

/**
 * The set of ADVISORY (edge) agents AKIS can dynamically dispatch, each with the
 * non-gate tools it is allowed to use.
 *
 * Registration is the RUNTIME gate-capability re-check behind the save-time workflow
 * validation: it REJECTS any agent that declares a gate capability, so a custom
 * agent can never be wired in with the power to approve, run tests, verify, or push.
 * Dispatch order = registration order.
 */
export class AgentRegistry {
  private readonly entries = new Map<string, Entry>()

  register(agent: AdvisoryAgent, capabilities: readonly string[] = [], phase?: AdvisoryPhase): void {
    const gate = capabilities.find(isGateTool)
    if (gate) throw new Error(`advisory agent '${agent.role}' cannot hold gate capability '${gate}'`)
    if (this.entries.has(agent.role)) throw new Error(`advisory agent '${agent.role}' already registered`)
    this.entries.set(agent.role, { agent, capabilities: new Set(capabilities), ...(phase !== undefined ? { phase } : {}) })
  }

  get size(): number {
    return this.entries.size
  }

  roles(): string[] {
    return [...this.entries.keys()]
  }

  has(role: string): boolean {
    return this.entries.has(role)
  }

  capabilities(role: string): ReadonlySet<string> {
    return this.entries.get(role)?.capabilities ?? new Set<string>()
  }

  /** All registered agents with their capability sets, in registration order. */
  list(): { agent: AdvisoryAgent; capabilities: ReadonlySet<string> }[] {
    return [...this.entries.values()].map(e => ({ agent: e.agent, capabilities: e.capabilities }))
  }

  /** The agents to dispatch AT a given edge, in registration order: those pinned to this
   *  `phase` PLUS any with no declared phase (default = every edge). Pure narrowing — a
   *  phase only changes *when* an advisory note is produced, never its (zero) authority. */
  listForPhase(phase: AdvisoryPhase): { agent: AdvisoryAgent; capabilities: ReadonlySet<string> }[] {
    return [...this.entries.values()]
      .filter(e => e.phase === undefined || e.phase === phase)
      .map(e => ({ agent: e.agent, capabilities: e.capabilities }))
  }
}
