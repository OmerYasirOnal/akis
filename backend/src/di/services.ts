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
import type { LlmProvider } from '../agent/LlmProvider.js'
import { createProvider } from '../agent/providers/createProvider.js'
import { makeGenerateText } from '../agent/criticBackend.js'

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
  /**
   * Real LLM provider for the critic. If omitted AND no `mockCriticScore` is
   * given, `createProvider()` resolves one from env (mock fallback with no key).
   */
  provider?: LlmProvider
  /**
   * Deterministic mock critic score: <60 → critical/hard-block; >=75 → approved.
   * When set, the critic uses the deterministic backend (the default test path);
   * when omitted, the critic uses the real `provider`.
   */
  mockCriticScore?: number
  /** Scribe asks for clarification instead of producing a spec. */
  mockNeedsClarification?: boolean
  /** The verifier's test runner. Default fails closed (0 tests). */
  testRunner?: TestRunner
}

export function buildServices(opts: BuildServicesOptions): OrchestratorServices {
  const bus = new EventBus()
  const github = new MockGitHubAdapter()
  const runner = opts.testRunner ?? createMockTestRunner()

  // Critic backend: deterministic mock when mockCriticScore is set (the test
  // path), else the real provider (createProvider falls back to mock with no key).
  let generateText: (system: string, user: string) => Promise<string>
  let providerName: string
  if (opts.mockCriticScore !== undefined) {
    const score = opts.mockCriticScore
    generateText = async (system: string): Promise<string> => {
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
    providerName = opts.providerName ?? 'mock'
  } else {
    const provider = opts.provider ?? createProvider()
    generateText = makeGenerateText(provider)
    providerName = opts.providerName ?? provider.name
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
