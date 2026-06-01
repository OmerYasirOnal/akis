import type { SessionStore } from '../store/SessionStore.js'
import { EventBus } from '../events/bus.js'
import { MockGitHubAdapter } from './MockGitHubAdapter.js'
import { DeterministicValidator } from '../validator/DeterministicValidator.js'
import { CriticAgent } from '../orchestrator/subagents/critic/CriticAgent.js'
import { ScribeAgent } from '../orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../orchestrator/subagents/TraceAgent.js'
import { createMockTestRunner, type TestRunner } from '../verify/TestRunner.js'
import { createVerifier } from '../verify/verifier.js'
import { createApprovalAuthority, type ApprovalAuthority } from '../gates/specGate.js'
import { loadSkills, type Skill } from '../skills/registry.js'

export interface OrchestratorServices {
  store: SessionStore
  bus: EventBus
  github: MockGitHubAdapter
  validator: DeterministicValidator
  critic: CriticAgent
  scribe: ScribeAgent
  proto: ProtoAgent
  trace: TraceAgent
  approvalAuthority: ApprovalAuthority
  skills: Skill[]
  providerName: string
}

/**
 * Explicit mock configuration for deterministic scenarios — no provider casting.
 * The real-provider sub-project replaces `critic.generateText` + `testRunner`
 * with real implementations behind the same interfaces; nothing here leaks the
 * mock into the production shape.
 */
export interface BuildServicesOptions {
  store: SessionStore
  skillsDir: string
  providerName?: string
  /** Critic score for the mock: <60 → critical/hard-block; >=75 → approved. Default 90. */
  mockCriticScore?: number
  /** Scribe asks for clarification instead of producing a spec. */
  mockNeedsClarification?: boolean
  /** The verifier's test runner. Default fails closed (0 tests). */
  testRunner?: TestRunner
}

export function buildServices(opts: BuildServicesOptions): OrchestratorServices {
  const bus = new EventBus()
  const github = new MockGitHubAdapter()
  const score = opts.mockCriticScore ?? 90
  const runner = opts.testRunner ?? createMockTestRunner()

  // Deterministic critic backend for the mock. The real-provider sub-project
  // swaps this for provider.chat(...) + parseAIJson.
  const generateText = async (system: string): Promise<string> => {
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

  return {
    store: opts.store,
    bus,
    github,
    validator: new DeterministicValidator(),
    critic: new CriticAgent({ generateText }, 75),
    scribe: new ScribeAgent({ bus, ...(opts.mockNeedsClarification !== undefined ? { needsClarification: opts.mockNeedsClarification } : {}) }),
    proto: new ProtoAgent({ bus }),
    trace: new TraceAgent({ bus, verifier: createVerifier(runner) }),
    approvalAuthority: createApprovalAuthority(),
    skills: loadSkills(opts.skillsDir),
    providerName: opts.providerName ?? 'mock',
  }
}
