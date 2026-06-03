import type { AkisEvent, Role } from '@akis/shared'
import type { EventBus } from '../events/bus.js'

export interface AgentStat { agent: Role; runs: number; ok: number }
export interface Analytics {
  sessions: number
  done: number
  failed: number
  running: number
  verifiedRuns: number
  testsRun: number
  passRate: number
  agents: AgentStat[]
  provider?: string
}

/**
 * Aggregate run analytics, fed by a single global `bus.tap`. Pure counters — no per-
 * session state retained beyond totals — so it's cheap and leak-free. Drives the
 * Analytics dashboard. (Not authoritative for gates; observability only.)
 */
export class StatsCollector {
  private sessions = 0
  private done = 0
  private failed = 0
  private cancelled = 0
  private verifiedRuns = 0
  private testsRun = 0
  private verifyTotal = 0
  private verifyPassed = 0
  private provider?: string
  private agents = new Map<Role, AgentStat>()

  /** Attach to a bus; returns the unsubscribe handle. */
  attach(bus: EventBus): () => void { return bus.tap(e => this.observe(e)) }

  observe(e: AkisEvent): void {
    switch (e.kind) {
      case 'session':
        if (e.status === 'started') this.sessions++
        else if (e.status === 'failed') this.failed++
        else if (e.status === 'cancelled') this.cancelled++ // terminal — must leave `running` (Stop/Cancel makes this reachable)
        break
      case 'agent_start': {
        const a = this.agents.get(e.agent) ?? { agent: e.agent, runs: 0, ok: 0 }
        a.runs++; this.agents.set(e.agent, a)
        break
      }
      case 'agent_end': {
        const a = this.agents.get(e.agent) ?? { agent: e.agent, runs: 0, ok: 0 }
        if (e.ok) a.ok++; this.agents.set(e.agent, a)
        break
      }
      case 'verify':
        this.verifyTotal++; if (e.passed) this.verifyPassed++
        this.testsRun += e.testsRun
        break
      case 'done':
        this.done++; if (e.verified) this.verifiedRuns++
        if (e.provider) this.provider = e.provider
        break
      default: break
    }
  }

  snapshot(): Analytics {
    return {
      sessions: this.sessions,
      done: this.done,
      failed: this.failed,
      running: Math.max(0, this.sessions - this.done - this.failed - this.cancelled),
      verifiedRuns: this.verifiedRuns,
      testsRun: this.testsRun,
      passRate: this.verifyTotal ? this.verifyPassed / this.verifyTotal : 0,
      agents: [...this.agents.values()],
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
    }
  }
}
