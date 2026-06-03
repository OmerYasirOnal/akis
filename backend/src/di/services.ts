import type { SessionStore } from '../store/SessionStore.js'
import { EventBus } from '../events/bus.js'
import { MockGitHubAdapter, type GitHubAdapter } from './MockGitHubAdapter.js'
import { selectGitHubAdapter } from './selectGitHubAdapter.js'
import { DeterministicValidator } from '../validator/DeterministicValidator.js'
import { CriticAgent } from '../orchestrator/subagents/critic/CriticAgent.js'
import { ScribeAgent } from '../orchestrator/subagents/ScribeAgent.js'
import { ProtoAgent } from '../orchestrator/subagents/ProtoAgent.js'
import { TraceAgent } from '../orchestrator/subagents/TraceAgent.js'
import type { TestRunner } from '../verify/TestRunner.js'
import { resolveVerifier, type VerifierSpec } from '../verify/verifier.js'
import { LocalDirectSandbox, type Sandbox } from '../exec/Sandbox.js'
import { createApprovalAuthority, type ApprovalAuthority } from '../gates/specGate.js'
import { loadSkills, buildSystemPrompt, type Skill } from '../skills/registry.js'
import { SCRIBE_SYSTEM } from '../orchestrator/subagents/ScribeAgent.js'
import { PROTO_SYSTEM } from '../orchestrator/subagents/ProtoAgent.js'
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
import { isCoreRole, type AgentConfig, type Role } from '@akis/shared'
import type { ProviderId } from '../agent/providers/catalog.js'

export interface OrchestratorServices {
  store: SessionStore
  bus: EventBus
  /** The push seam (GitHubAdapter). MockGitHubAdapter by default (and ALWAYS under
   *  NODE_ENV=test); the opt-in RealGitHubAdapter when AKIS_GITHUB_PUSH_TOKEN +
   *  AKIS_GITHUB_PUSH_REPO are both set. Reached only through the ApprovedPush gate. */
  github: GitHubAdapter
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
  /** Ed25519 signer for the durable, third-party-verifiable Build Passport. ADDITIVE +
   *  OFF the gate path: when present, a VERIFIED build signs a passport over the
   *  ALREADY-MINTED VerifyToken facts (it can only attest, never mint/forge). Absent ⇒
   *  no passport is produced (default boot unchanged); the PRIVATE key is never logged
   *  or returned (only `signer.publicKey` is exposed). */
  passportSigner?: import('../verify/passport.js').PassportSigner
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
  /** The BM25 lexical index (the OTHER half of hybrid retrieval). When DATABASE_URL is set the
   *  server injects one ALREADY HYDRATED from the persisted corpus so the lexical half survives a
   *  restart (it is otherwise rebuilt empty on boot). Absent it, buildRag's fresh empty index is
   *  used (the in-memory default, byte-for-byte unchanged). Only meaningful when `rag` is on. */
  bm25?: import('../knowledge/store/Bm25Index.js').Bm25Index
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
  /** Per-agent selected skill NAMES from a resolved WorkflowConfig (P3-AGENT-1). For a
   *  core producer (scribe/proto) the named skills are resolved against the loaded
   *  registry and composed onto that agent's base system prompt via buildSystemPrompt.
   *  Omitted / empty / unknown names ⇒ the byte-identical base prompt of today. */
  agentSkills?: Partial<Record<import('@akis/shared').Role, string[]>>
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
  /** Ed25519 signer for the Build Passport. ADDITIVE — when present, a verified build signs
   *  a durable passport over the already-minted VerifyToken facts. Absent ⇒ no passport
   *  (default boot unchanged). The PRIVATE key is held only on the signer (never logged/returned). */
  passportSigner?: import('../verify/passport.js').PassportSigner
}

export function buildServices(opts: BuildServicesOptions): OrchestratorServices {
  const bus = opts.bus ?? new EventBus()
  // The in-memory adapter the RAG read path reads from (its MockRepoReader calls
  // `.read()`, mock-only). ALWAYS a mock — the RAG real-reader switch is a separate
  // AKIS_GITHUB_TOKEN concern (buildRag), independent of the push-adapter selection.
  const mockGithub = new MockGitHubAdapter()
  // ── P1-CORE-2: push-seam selection (opt-in) ────────────────────────────────────
  // The push seam the orchestrator pushes to THROUGH the unchanged ApprovedPush gate.
  // RealGitHubAdapter ONLY when AKIS_GITHUB_PUSH_TOKEN + AKIS_GITHUB_PUSH_REPO are both
  // set AND NODE_ENV!=='test'; otherwise the MockGitHubAdapter (default boot, byte-for-
  // byte identical to today). Token read here, NEVER logged/returned. selectGitHubAdapter
  // falls back to the mock on any misconfig so a bad opt-in can never break boot.
  const github: GitHubAdapter = selectGitHubAdapter(opts.env, mockGithub)
  // Verifier selection: explicit injected runner > real (opt-in) > mock (fail-closed
  // default). The runner→Verifier construction has ONE home (verifier.ts/resolveVerifier);
  // there is no importable `createVerifier`, so no other module can wrap a fake runner
  // into a Verifier (B2 — capability leak closed). Only Trace is handed the result.
  const verifierSpec: VerifierSpec =
    opts.testRunner ? { kind: 'runner', runner: opts.testRunner }
      : opts.realTests ? { kind: 'real', sandbox: opts.sandbox ?? new LocalDirectSandbox() }
      : { kind: 'mock' }

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

  // RAG read path reads the in-memory `mockGithub` (mock-only `.read()`); the push
  // seam (`github`, above) is the selected adapter (mock or RealGitHubAdapter).
  const knowledgeWiring = resolveKnowledge(opts, bus, mockGithub)
  // RAG is "on" for Scribe iff a real knowledge port is wired (the flag built the
  // RAG stack, or a caller injected an explicit non-Null port). The NullKnowledgePort
  // default ⇒ off ⇒ Scribe stays byte-identical single-shot (P3-AGENT-2).
  const ragEnabled = !(knowledgeWiring.knowledge instanceof NullKnowledgePort)

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

  // P3-AGENT-1 / -1B: inject the workflow-selected skills into each core agent's system
  // prompt(s). The registry is loaded once here; `selectSkillsFor` resolves a role's
  // selected skill NAMES against it (order preserved, unknown names dropped, never a
  // throw) into the matching Skill[]. The producers (Scribe/Proto) fold them onto a
  // single base prompt via buildSystemPrompt (composeFor → an injectable systemPrompt
  // string); the Critic — which builds its TWO prompts internally per call — instead
  // receives the resolved Skill[] and folds them onto BOTH via the same helper. A role
  // with NO selected skills (the default) resolves to [] ⇒ byte-identical base prompt(s).
  // Per-agent selection is honored: a role's names never reach another role's prompt.
  const skills = loadSkills(opts.skillsDir)
  const selectSkillsFor = (role: Role): Skill[] => {
    const names = opts.agentSkills?.[role]
    if (!names || names.length === 0) return []
    return names.map(n => skills.find(s => s.name === n)).filter((s): s is Skill => s !== undefined)
  }
  const composeFor = (role: 'scribe' | 'proto', base: string): string | undefined => {
    const selected = selectSkillsFor(role)
    if (selected.length === 0) return undefined
    return buildSystemPrompt(base, selected)
  }
  const scribePrompt = composeFor('scribe', SCRIBE_SYSTEM)
  const protoPrompt = composeFor('proto', PROTO_SYSTEM)
  const criticSkills = selectSkillsFor('critic')

  return {
    store: opts.store,
    bus,
    github,
    validator: new DeterministicValidator(),
    // P3-AGENT-1B: the critic's selected skills are folded onto BOTH its prompts
    // internally. No critic skills (the default) ⇒ [] ⇒ both prompts byte-identical.
    critic: new CriticAgent({ generateText }, 75, criticSkills),
    // RAG ON ⇒ Scribe composes via the bounded retrieve_knowledge tool loop; OFF ⇒
    // single-shot. The same knowledge port the SharedContext reads is reused (P3-AGENT-2).
    scribe: new ScribeAgent({
      bus, provider: providerFor('scribe'),
      ...(opts.mockNeedsClarification !== undefined ? { needsClarification: opts.mockNeedsClarification } : {}),
      ...(ragEnabled ? { knowledge: knowledgeWiring.knowledge, ragEnabled: true } : {}),
      ...(scribePrompt !== undefined ? { systemPrompt: scribePrompt } : {}),
    }),
    proto: new ProtoAgent({ bus, provider: providerFor('proto'), ...(protoPrompt !== undefined ? { systemPrompt: protoPrompt } : {}) }),
    trace: new TraceAgent({ bus, verifier: resolveVerifier(verifierSpec) }),
    approvalAuthority: createApprovalAuthority(),
    skills,
    provider,
    providerName,
    ...(opts.iterateBudget !== undefined ? { iterateBudget: opts.iterateBudget } : {}),
    ...(opts.gatePolicy !== undefined ? { gatePolicy: opts.gatePolicy } : {}),
    ...(advisoryAgents.size > 0 ? { advisoryAgents } : {}),
    ...(opts.passportSigner ? { passportSigner: opts.passportSigner } : {}),
    ...knowledgeWiring,
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
      // (opt-in), AND so the embedding provider is selected from env: a real
      // ApiEmbeddingProvider when an OpenAI key resolves, else the offline default.
      ...(opts.env ? { env: opts.env } : {}),
      // The SAME encrypted KeyStore the chat providers use — consulted (after env) to
      // resolve the embedding key. No env key + a Settings-saved key still turns on
      // real embeddings. Absent it, the offline LocalEmbeddingProvider is used.
      ...(opts.keyStore ? { keyStore: opts.keyStore } : {}),
      // Durable corpus: a PgVectorStore when DATABASE_URL is set; else the in-memory default.
      ...(opts.vectorStore ? { vectorStore: opts.vectorStore } : {}),
      // Durable lexical half: a Bm25Index hydrated from that same corpus so RRF's BM25 side
      // survives a restart; else buildRag's fresh empty index (in-memory default, unchanged).
      ...(opts.bm25 ? { bm25: opts.bm25 } : {}),
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
