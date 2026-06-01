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
import { NullKnowledgePort, type KnowledgePort } from '../knowledge/KnowledgePort.js'
import { buildRag } from '../knowledge/buildRag.js'
import type { IngestionSink } from '../knowledge/IngestionSink.js'

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
  /** Read-only knowledge retrieval that feeds SharedContext (NullKnowledgePort until RAG). */
  knowledge: KnowledgePort
  /** When RAG is on, the bus sink the orchestrator subscribes per session (F1-AC17). */
  ingestionSink?: IngestionSink
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
  /**
   * Optional key source (the encrypted KeyStore) consulted after env when
   * resolving a provider — so a Settings-saved key actually reaches the critic.
   * Only used when `provider` is not supplied and `mockCriticScore` is absent.
   */
  keyStore?: { get(provider: string): string | undefined }
  /** Injectable event bus (e.g. a small-cap bus to exercise SSE overflow/resume). */
  bus?: EventBus
  /** Knowledge port feeding SharedContext. Defaults to NullKnowledgePort (no RAG yet). */
  knowledge?: KnowledgePort
  /** Feature flag (F1-AC11): when true, build the embedded RAG stack + ingestion sink.
   *  Default OFF → NullKnowledgePort, behavior identical to no-RAG. */
  rag?: boolean
  /** Inject a prebuilt ingestion sink alongside an explicit `knowledge` port (tests
   *  that need the queue handle to drain ingestion deterministically). */
  ingestionSink?: IngestionSink
}

export function buildServices(opts: BuildServicesOptions): OrchestratorServices {
  const bus = opts.bus ?? new EventBus()
  const github = new MockGitHubAdapter()
  const runner = opts.testRunner ?? createMockTestRunner()

  // The provider feeds the LIVE sub-agents (Scribe/Proto) AND the critic. Under
  // NODE_ENV=test createProvider returns the mock; with mockCriticScore the critic
  // uses a deterministic score backend instead, but Scribe/Proto still need a
  // provider object — so we always resolve one (mock in tests / keyless via
  // allowMock for deterministic runs).
  const provider =
    opts.provider ??
    createProvider({
      ...(opts.keyStore ? { keyStore: opts.keyStore } : {}),
      // When a deterministic mock-critic run is requested, allow the mock provider
      // for the sub-agents too (keeps suites/smoke green without a real key).
      ...(opts.mockCriticScore !== undefined ? { allowMock: true } : {}),
    })

  // Critic backend: deterministic score when mockCriticScore is set (the test
  // path), else the real provider via the criticBackend adapter.
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
    providerName = opts.providerName ?? provider.name
  } else {
    generateText = makeGenerateText(provider)
    providerName = opts.providerName ?? provider.name
  }

  return {
    store: opts.store,
    bus,
    github,
    validator: new DeterministicValidator(),
    critic: new CriticAgent({ generateText }, 75),
    scribe: new ScribeAgent({ bus, provider, ...(opts.mockNeedsClarification !== undefined ? { needsClarification: opts.mockNeedsClarification } : {}) }),
    proto: new ProtoAgent({ bus, provider }),
    trace: new TraceAgent({ bus, verifier: createVerifier(runner) }),
    approvalAuthority: createApprovalAuthority(),
    skills: loadSkills(opts.skillsDir),
    providerName,
    ...resolveKnowledge(opts, bus),
  }
}

/** F1-AC11: RAG behind a flag. ON → embedded RAG stack + ingestion sink; OFF (default)
 *  or an explicit knowledge port → no sink, behavior identical to no-RAG. */
function resolveKnowledge(opts: BuildServicesOptions, bus: EventBus): { knowledge: KnowledgePort; ingestionSink?: IngestionSink } {
  if (opts.knowledge) return { knowledge: opts.knowledge, ...(opts.ingestionSink ? { ingestionSink: opts.ingestionSink } : {}) }
  if (opts.rag) {
    const stack = buildRag({ bus })
    return { knowledge: stack.port, ingestionSink: stack.sink }
  }
  return { knowledge: new NullKnowledgePort() }
}
