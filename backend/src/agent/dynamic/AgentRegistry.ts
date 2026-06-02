import { isGateTool } from '@akis/shared'
import type { AdvisoryAgent } from './AdvisoryAgent.js'

interface Entry {
  agent: AdvisoryAgent
  capabilities: ReadonlySet<string>
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

  register(agent: AdvisoryAgent, capabilities: readonly string[] = []): void {
    const gate = capabilities.find(isGateTool)
    if (gate) throw new Error(`advisory agent '${agent.role}' cannot hold gate capability '${gate}'`)
    if (this.entries.has(agent.role)) throw new Error(`advisory agent '${agent.role}' already registered`)
    this.entries.set(agent.role, { agent, capabilities: new Set(capabilities) })
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
}
