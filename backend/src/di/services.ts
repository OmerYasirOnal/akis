import type { SessionStore } from '../store/SessionStore.js'
import { EventBus } from '../events/bus.js'
import { MockGitHubAdapter } from './MockGitHubAdapter.js'
import { DeterministicValidator } from '../validator/DeterministicValidator.js'
import { CriticAgent } from '../orchestrator/subagents/critic/CriticAgent.js'
import { ScribeAgent } from '../orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../orchestrator/subagents/TraceAgent.js'
import { createMockTestRunner, createRealTestRunner, type TestRunner } from '../verify/TestRunner.js'
import { createVerifier } from '../verify/verifier.js'
import { LocalDirectSandbox, type Sandbox } from '../exec/Sandbox.js'
import { createApprovalAuthority, type ApprovalAuthority } from '../gates/specGate.js'
import { loadSkills, type Skill } from '../skills/registry.js'
import type { LlmProvider } from '../agent/LlmProvider.js'
import { createProvider } from '../agent/providers/createProvider.js'
import { makeGenerateText } from '../agent/criticBackend.js'
import { NullKnowledgePort, type KnowledgePort } from '../knowledge/KnowledgePort.js'
import { buildRag } from '../knowledge/buildRag.js'
import type { IngestionSink } from '../knowledge/IngestionSink.js'
import type { RagService } from '../knowledge/RagService.js'
import type { IngestQueue } from '../knowledge/ingest/IngestQueue.js'
import type { UploadSource } from '../knowledge/ingest/UploadSource.js'
import type { RepoSource } from '../knowledge/ingest/RepoSource.js'
import { AgentRegistry } from '../agent/dynamic/AgentRegistry.js'
import { LlmAdvisoryAgent } from '../agent/dynamic/AdvisoryAgent.js'
import { isCoreRole, type AgentConfig } from '@akis/shared'
import type { ProviderId } from '../agent/providers/catalog.js'

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
  /** The resolved LLM provider (feeds the agents; also used by the AKIS chat route). */
  provider: LlmProvider
  providerName: string
  /** Per-run iterate budget (a workflow may tighten it below the default). */
  iterateBudget?: number
  /** Per-run gate policy (tighten-only — may ADD a required human resolution). */
  gatePolicy?: import('@akis/shared').GatePolicy
  /** Read-only knowledge retrieval that feeds SharedContext (NullKnowledgePort until RAG). */
  knowledge: KnowledgePort
  /** When RAG is on, the bus sink the orchestrator subscribes per session (F1-AC17). */
  ingestionSink?: IngestionSink
  /** The RagService — surfaced ONLY when RAG is on, so the knowledge routes can ingest
   *  uploads/repo files and a host can read metrics. Undefined when RAG is off. */
  ragService?: RagService
  /** The RAG ingestion queue — surfaced ONLY when RAG is on (deterministic drain in
   *  tests / metrics). Undefined when RAG is off. */
  ragQueue?: IngestQueue
  /** Upload ingestion source (issue #7 AC2) — surfaced ONLY when RAG is on; the upload
   *  route calls it (owner-scoped). Undefined when RAG is off. */
  uploadSource?: UploadSource
  /** Repo ingestion source (issue #7 AC1) — surfaced ONLY when RAG is on; the repo
   *  trigger route calls it. Reads the same shared `github` adapter. Undefined when off. */
  repoSource?: RepoSource
  /** The tenancy resolver the RAG port retrieves with — the knowledge routes stamp
   *  ingestion with it so a write is retrievable. Surfaced ONLY when RAG is on. */
  ragUserIdFor?: (sessionId: string) => string
  /** Custom (non-core) workflow agents AKIS dispatches as advisory at the edges (CF4).
   *  Empty when no workflow / no custom agents — the orchestrator then dispatches none. */
  advisoryAgents?: AgentRegistry
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
  /** Opt-in: use the REAL runner (Playwright+Cucumber via Sandbox) instead of the
   *  mock, so 'verified' means a real >=1-test pass. Ignored if `testRunner` is given. */
  realTests?: boolean
  /** Sandbox for the real runner (default LocalDirectSandbox; injectable for tests). */
  sandbox?: Sandbox
  /** Per-run iterate budget (a workflow may tighten it below the default 3). */
  iterateBudget?: number
  /** Per-run gate policy (tighten-only). */
  gatePolicy?: import('@akis/shared').GatePolicy
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
  /** Durable vector store for the RAG corpus. Only meaningful when `rag` is on (and no
   *  explicit `knowledge` port is given): when DATABASE_URL is set the server injects a
   *  hydrated PgVectorStore so the corpus survives restart; absent it, buildRag's default
   *  MemoryVectorStore is used (the keyless default, byte-for-byte unchanged). */
  vectorStore?: import('../knowledge/store/VectorStore.js').VectorStore
  /** Feature flag (F1-AC11): when true, build the embedded RAG stack + ingestion sink.
   *  Default OFF → NullKnowledgePort, behavior identical to no-RAG. */
  rag?: boolean
  /** Default second-stage rerank toggle (issue #7 AC3): threaded into buildRag. Only
   *  meaningful when `rag` is on. Defaults to on; false wires a NoopReranker. A skippable
   *  quality knob, never a gate (per-call `RetrieveQuery.rerank` can still override). */
  rerank?: boolean
  /** Inject a prebuilt ingestion sink alongside an explicit `knowledge` port (tests
   *  that need the queue handle to drain ingestion deterministically). */
  ingestionSink?: IngestionSink
  /** Per-agent {provider, model} from a resolved WorkflowConfig (F2-AC9). When set
   *  for a producer role, that agent gets its own provider; otherwise the default. */
  agentModels?: Partial<Record<import('@akis/shared').Role, { provider: import('./../agent/providers/catalog.js').ProviderId; model?: string }>>
  /** Custom (non-core) workflow agents to wire as advisory edge agents (CF4). A
   *  declared gate capability is REJECTED here (runtime re-check) — buildServices throws. */
  customAgents?: AgentConfig[]
  /** Prebuilt advisory registry to use as the base (tests/advanced callers inject
   *  custom AdvisoryAgent stubs here, e.g. a throwing advisor); `customAgents` are
   *  registered on top of it. */
  advisoryAgents?: AgentRegistry
  /** Env source threaded into the RAG build for repo-reader selection (AKIS_GITHUB_TOKEN
   *  + repo target). Only meaningful when `rag` is on. Absent ⇒ MockRepoReader (default
   *  OFF, zero behavior change). */
  env?: Record<string, string | undefined>
}

export function buildServices(opts: BuildServicesOptions): OrchestratorServices {
  const bus = opts.bus ?? new EventBus()
  const github = new MockGitHubAdapter()
  // Runner selection: explicit > real (opt-in) > mock (fail-closed default).
  const runner: TestRunner =
    opts.testRunner ??
    (opts.realTests ? createRealTestRunner({ sandbox: opts.sandbox ?? new LocalDirectSandbox() }) : createMockTestRunner())

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

  // Per-agent model binding (F2-AC9): a producer with a resolved {provider, model}
  // gets its own provider; everyone else shares the default. Under NODE_ENV=test
  // createProvider returns the mock regardless, so this stays test-safe.
  // Build a per-agent provider with the standard option spreads (shared by producer
  // model-binding and the advisory agents — one place to evolve createProvider opts).
  const makeProvider = (p: ProviderId, model?: string): LlmProvider => createProvider({
    provider: p,
    ...(model !== undefined ? { model } : {}),
    ...(opts.keyStore ? { keyStore: opts.keyStore } : {}),
    ...(opts.mockCriticScore !== undefined ? { allowMock: true } : {}),
  })

  const providerFor = (role: 'scribe' | 'proto'): LlmProvider => {
    const m = opts.agentModels?.[role]
    return m ? makeProvider(m.provider, m.model) : provider
  }

  // Custom (non-core) workflow agents → advisory edge agents (CF4). Registration
  // REJECTS any gate capability (defense-in-depth behind save-time validation), so a
  // throw here means a gate-holding custom agent slipped past validation. Each gets
  // its own provider (its model, else the default). A prebuilt `advisoryAgents`
  // registry (tests/advanced callers) is the base; customAgents register on top.
  // NOTE: AgentConfig.skills is not yet applied to advisory agents (prompt + tools
  // only) — an intentional no-op until advisory skills are scoped.
  const advisoryAgents = opts.advisoryAgents ?? new AgentRegistry()
  for (const a of opts.customAgents ?? []) {
    if (isCoreRole(a.role)) continue // core agents run on the spine, never as advisory
    const agentProvider = a.model?.providerId ? makeProvider(a.model.providerId as ProviderId, a.model.modelId) : provider
    advisoryAgents.register(
      new LlmAdvisoryAgent({ role: a.role, provider: agentProvider, ...(a.basePromptVariant !== undefined ? { persona: a.basePromptVariant } : {}) }),
      a.tools ?? [],
      a.phase, // undefined ⇒ dispatched at every edge; a value pins it to that one edge
    )
  }

  return {
    store: opts.store,
    bus,
    github,
    validator: new DeterministicValidator(),
    critic: new CriticAgent({ generateText }, 75),
    scribe: new ScribeAgent({ bus, provider: providerFor('scribe'), ...(opts.mockNeedsClarification !== undefined ? { needsClarification: opts.mockNeedsClarification } : {}) }),
    proto: new ProtoAgent({ bus, provider: providerFor('proto') }),
    trace: new TraceAgent({ bus, verifier: createVerifier(runner) }),
    approvalAuthority: createApprovalAuthority(),
    skills: loadSkills(opts.skillsDir),
    provider,
    providerName,
    ...(opts.iterateBudget !== undefined ? { iterateBudget: opts.iterateBudget } : {}),
    ...(opts.gatePolicy !== undefined ? { gatePolicy: opts.gatePolicy } : {}),
    ...(advisoryAgents.size > 0 ? { advisoryAgents } : {}),
    ...resolveKnowledge(opts, bus, github),
  }
}

/** What buildServices surfaces for the knowledge subsystem. The source/queue handles
 *  are present ONLY when this build owns the RAG stack (opts.rag) — an injected port has
 *  no handles to surface, and the RAG-off default surfaces none (no behavior change). */
interface KnowledgeWiring {
  knowledge: KnowledgePort
  ingestionSink?: IngestionSink
  ragService?: RagService
  ragQueue?: IngestQueue
  uploadSource?: UploadSource
  repoSource?: RepoSource
  ragUserIdFor?: (sessionId: string) => string
}

/** F1-AC11: RAG behind a flag. ON → embedded RAG stack + ingestion sink + repo/upload
 *  sources (issue #7); OFF (default) or an explicit knowledge port → no stack handles,
 *  behavior identical to no-RAG. The RepoSource reads the SAME shared `github` adapter
 *  the orchestrator pushes to, so a freshly pushed repo is immediately ingestable. */
function resolveKnowledge(opts: BuildServicesOptions, bus: EventBus, github: MockGitHubAdapter): KnowledgeWiring {
  if (opts.knowledge) return { knowledge: opts.knowledge, ...(opts.ingestionSink ? { ingestionSink: opts.ingestionSink } : {}) }
  if (opts.rag) {
    const stack = buildRag({
      bus, github,
      ...(opts.rerank !== undefined ? { rerank: opts.rerank } : {}),
      // Thread env so a configured AKIS_GITHUB_TOKEN selects the RealGitHubRepoReader
      // (opt-in); absent it the default MockRepoReader is used (zero behavior change).
      ...(opts.env ? { env: opts.env } : {}),
      // Durable corpus: a PgVectorStore when DATABASE_URL is set; else the in-memory default.
      ...(opts.vectorStore ? { vectorStore: opts.vectorStore } : {}),
    })
    return {
      knowledge: stack.port,
      ingestionSink: stack.sink,
      ragService: stack.service,
      ragQueue: stack.queue,
      uploadSource: stack.uploadSource,
      repoSource: stack.repoSource,
      ragUserIdFor: stack.userIdFor,
    }
  }
  return { knowledge: new NullKnowledgePort() }
}
