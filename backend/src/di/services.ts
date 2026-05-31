import type { LlmProvider } from '../agent/LlmProvider.js'
import type { SessionStore } from '../store/SessionStore.js'
import { EventBus } from '../events/bus.js'
import { MockGitHubAdapter } from './MockGitHubAdapter.js'
import { DeterministicValidator } from '../validator/DeterministicValidator.js'
import { CriticAgent } from '../orchestrator/subagents/critic/CriticAgent.js'
import { ScribeAgent } from '../orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../orchestrator/subagents/TraceAgent.js'
import { getKnobs } from '../orchestrator/subagents/knobs.js'
import { loadSkills, type Skill } from '../skills/registry.js'

export interface OrchestratorServices {
  provider: LlmProvider
  store: SessionStore
  bus: EventBus
  github: MockGitHubAdapter
  validator: DeterministicValidator
  critic: CriticAgent
  scribe: ScribeAgent
  proto: ProtoAgent
  trace: TraceAgent
  skills: Skill[]
}

/**
 * Build the DI container once. The Critic's generateText is backed by the
 * provider; on the mock it returns a deterministic JSON review derived from the
 * `mockCriticScore` knob (score < 60 → a critical finding → hard-block;
 * score >= 75 → approved). A real provider has no knobs → the real model output
 * is parsed (real-AI sub-project).
 */
export function buildServices(opts: { provider: LlmProvider; store: SessionStore; skillsDir: string }): OrchestratorServices {
  const { provider, store } = opts
  const bus = new EventBus()
  const github = new MockGitHubAdapter()

  const generateText = async (system: string, user: string): Promise<string> => {
    const knobs = getKnobs(provider)
    if (knobs.mockCriticScore !== undefined) {
      const score = knobs.mockCriticScore
      const critical = score < 60
      const isCode = system.includes('code reviewer')
      return JSON.stringify({
        approved: score >= 75,
        overallScore: score,
        summary: 'mock review',
        findings: critical
          ? [{ severity: 'critical', category: 'security', description: 'mock critical finding', suggestion: 'fix it' }]
          : [],
        reviewType: isCode ? 'code_review' : 'spec_review',
        iteration: 1,
        hasCriticalFinding: critical,
        maxSeverity: critical ? 'critical' : 'info',
      })
    }
    return (await provider.chat({ role: 'critic', system, messages: [{ role: 'user', content: user }], tools: [] })).text ?? ''
  }

  return {
    provider,
    store,
    bus,
    github,
    validator: new DeterministicValidator(),
    critic: new CriticAgent({ generateText }, 75),
    scribe: new ScribeAgent({ provider, bus }),
    proto: new ProtoAgent({ provider, bus, github }),
    trace: new TraceAgent({ provider, bus }),
    skills: loadSkills(opts.skillsDir),
  }
}
