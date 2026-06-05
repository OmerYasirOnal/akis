import Fastify, { type FastifyInstance } from 'fastify'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { JsonFileKeyStore, type KeyStore } from '../keys/KeyStore.js'
import { JsonFileGitHubConnectionStore, GitHubConnectionMemoryStore, type GitHubConnectionStore } from '../keys/GitHubConnectionStore.js'
import { randomBytes } from 'node:crypto'
import { registerProviderRoutes } from './providers.routes.js'
import { registerSessionRoutes } from './sessions.routes.js'
import { registerPreviewRoutes, wirePreviewPrewarm } from './preview.routes.js'
import { registerWorkflowRoutes } from './workflows.routes.js'
import { registerAuthRoutes, userIdFromRequest } from './auth.routes.js'
import { UserStore, type UserStorePort } from '../auth/UserStore.js'
import { JsonFileUserStore } from '../auth/JsonFileUserStore.js'
import { createPgUserStoreWithClient } from '../auth/PgUserStore.js'
import { createPgPool, runMigrations, ensurePgVectorColumn } from '../store/pg.js'
import { PgSessionStore } from '../store/PgSessionStore.js'
import { PgWorkflowStore } from '../workflow/PgWorkflowStore.js'
import { PgVectorStore } from '../knowledge/store/PgVectorStore.js'
import { Bm25Index } from '../knowledge/store/Bm25Index.js'
import { activeEmbeddingDim } from '../knowledge/embedding/ApiEmbeddingProvider.js'
import type { VectorStore } from '../knowledge/store/VectorStore.js'
import { cookieConfigFromEnv } from '../auth/cookie.js'
import { selectMailer } from '../mail/selectMailer.js'
import type { Mailer } from '../mail/Mailer.js'
import { registerAnalyticsRoutes } from './analytics.routes.js'
import { StatsCollector } from '../analytics/StatsCollector.js'
import { registerChatRoutes } from './chat.routes.js'
import { registerUsageRoutes } from './usage.routes.js'
import { registerOpsRoutes, buildOpsBlock } from './ops.routes.js'
import { UsageStore, type UsageStorePort } from '../usage/UsageStore.js'
import { JsonFileUsageStore } from '../usage/JsonFileUsageStore.js'
import { createPgUsageStoreWithClient } from '../usage/PgUsageStore.js'
import { UsageCollector } from '../usage/UsageCollector.js'
import { resolveQuotaPolicy } from '../usage/quota.js'
import { registerKnowledgeRoutes, DEFAULT_UPLOAD_MAX_BYTES } from './knowledge.routes.js'
import { registerOAuthRoutes } from './oauth.routes.js'
import { registerGitHubConnectRoutes } from './githubConnect.routes.js'
import { configuredProviders } from '../auth/oauth.js'
import { WorkflowStore, type WorkflowStorePort } from '../workflow/WorkflowStore.js'
import { workflowToAgentModels, workflowToAgentSkills, workflowCustomAgents } from '../workflow/resolve.js'
import type { WorkflowConfig } from '@akis/shared'
import { buildServices, type OrchestratorServices } from '../di/services.js'
import { Orchestrator } from '../orchestrator/Orchestrator.js'
import { MockSessionStore } from '../store/MockSessionStore.js'
import { JsonFileSessionStore } from '../store/JsonFileSessionStore.js'
import type { SessionStore } from '../store/SessionStore.js'
import { registerStatic, staticServingEnabled, defaultStaticRoot } from './static.js'
import { installGracefulShutdown } from './shutdown.js'
import type { SqlClient } from '../store/pg.js'
import { PreviewRegistry } from '../preview/PreviewRegistry.js'
import { reclaimWorkspaces } from '../preview/Workspace.js'
import { LocalDirectSandbox } from '../exec/Sandbox.js'
import { MockProvider } from '../agent/providers/mock/MockProvider.js'
import { hasRealProviderKey } from '../agent/providers/createProvider.js'
import { createMockTestRunner } from '../verify/TestRunner.js'
import { makePreviewBoot } from '../verify/previewBoot.js'
import type { BootSmokeDeps } from '../verify/bootSmoke.js'
import { loadOrCreatePassportSigner, fileDevKeyStore, type PassportSigner } from '../verify/passport.js'
import { nextTs } from '../events/clock.js'

export interface ServerDeps {
  keyStore: KeyStore
  /** Per-user GitHub connection store. Built in start() (where the master key is in scope,
   *  exactly like keyStore) and threaded here; tests/host-injection get an in-memory default
   *  in buildServer. Holds each user's ENCRYPTED GitHub token + their target repo. */
  connections?: GitHubConnectionStore
  env?: Record<string, string | undefined>
  /** Test/host injection of the orchestrator stack. Built from defaults if omitted. */
  services?: OrchestratorServices
  orchestrator?: Orchestrator
  /** Skills library dir; defaults to the bundled library next to the sources. */
  skillsDir?: string
  /** Workflow preset store (in-memory by default; injectable for tests/persistence —
   *  a PgWorkflowStore when DATABASE_URL is set). */
  workflowStore?: WorkflowStorePort
  /** User store for auth (in-memory by default; a PgUserStore when DATABASE_URL is set). */
  userStore?: UserStorePort
  /** Mailer seam (P5-OPS-1). Defaults to env-driven `selectMailer` — a NoopMailer unless
   *  SMTP is configured, so the default boot is unchanged. Injectable for tests. */
  mailer?: Mailer
  /** Session store (MockSessionStore by default; a PgSessionStore when DATABASE_URL is
   *  set). Injected so the durable store flows through buildServices unchanged. */
  sessionStore?: SessionStore
  /** Durable RAG vector store (a hydrated PgVectorStore when DATABASE_URL is set; absent it
   *  buildServices uses the in-memory default). Only consulted when RAG is on (AKIS_RAG);
   *  the keyless/in-memory default path is byte-for-byte unchanged. */
  vectorStore?: VectorStore
  /** The BM25 lexical index, hydrated from the persisted corpus when DATABASE_URL is set, so the
   *  lexical half of hybrid retrieval (RRF) survives a restart instead of rebuilding empty. Built
   *  in buildPgStores alongside the PgVectorStore from the SAME rows. Only consulted when RAG is
   *  on; the keyless/in-memory default path is byte-for-byte unchanged. */
  bm25?: Bm25Index
  /** Built-frontend dist dir for single-container static serving (defaults to
   *  frontend/dist resolved next to the sources; overridable for tests/hosts). */
  staticRoot?: string
  /** Active persistence mode, surfaced on /health for observability (a degraded
   *  in-memory fallback otherwise looks identical to a healthy durable boot). Defaults
   *  to 'memory'; start() sets 'postgres' when the durable stores are wired. */
  persistence?: 'postgres' | 'memory'
  /** Per-user token-usage ledger (in-memory by default; a PgUsageStore when DATABASE_URL is
   *  set; a dev JSON file otherwise). Injectable for tests (pre-seed over budget to assert the
   *  fail-closed 429). The quota POLICY itself is resolved from env (AKIS_USER_TOKEN_BUDGET). */
  usage?: UsageStorePort
  /** Bounded DB reachability probe for /health + /api/ops (built in start() from the pool with a
   *  500ms Promise.race timeout). Absent ⇒ db:'off'. Injectable so a test forces the degraded
   *  path WITHOUT a real DB. */
  dbPing?: () => Promise<boolean>
}

const defaultSkillsDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../skills/library')

const flag = (v: string | undefined): boolean => v === '1' || v === 'true'

/** Build the Fastify app with injected deps (testable via app.inject / listen). */
export function buildServer(deps: ServerDeps): FastifyInstance {
  // logger off: never risk logging key bodies. forceCloseConnections: a hijacked/upgraded
  // socket (the preview reverse-proxy + the HMR WebSocket tunnel) is NOT an idle keep-alive
  // connection, so the default close() would hang on it until the 10s backstop force-exits —
  // and then stopAll()/drain/pool-close never run, orphaning preview process groups + leaking
  // loopback ports (the exact failure the teardown work fixes). Force-close so close() resolves
  // promptly and the rest of graceful shutdown actually runs. (PR #83 review)
  const env0 = deps.env ?? (process.env as Record<string, string | undefined>)
  // TRUST_PROXY (review #112): behind a reverse proxy, req.ip is otherwise the PROXY's
  // address — every client shares one rate-limit bucket (collective lockout). Opt-IN by
  // env because the inverse is worse: trusting X-Forwarded-For while directly exposed
  // lets clients spoof fresh IPs and rotate around the limiter entirely.
  const app = Fastify({ logger: false, forceCloseConnections: true, trustProxy: env0.TRUST_PROXY === '1' || env0.TRUST_PROXY === 'true' })
  const env = env0

  // FAIL-CLOSED in production: a demo flag (AKIS_ALLOW_MOCK / AKIS_DEMO_VERIFY) fakes
  // verification — a build can reach done+preview WITHOUT real tests. In production that
  // must be a DELIBERATE, acknowledged choice; otherwise refuse to boot (mirrors the
  // persistenceRequired fail-closed). Dev/self-host keeps the convenient keyless demo.
  const demo = resolveDemoMode(env)
  if (demo.fatal) {
    throw new Error(
      'A demo flag (AKIS_ALLOW_MOCK / AKIS_DEMO_VERIFY) fakes verification — a build can reach ' +
      'done+preview WITHOUT real tests — and NODE_ENV=production. Refusing to boot a production ' +
      'server that silently ships unverified output. Remove the demo flag (and configure a real ' +
      'provider key + verification), or set AKIS_ALLOW_DEMO_IN_PROD=1 to explicitly acknowledge a ' +
      'demo deployment (it is then flagged `demo` on /health).',
    )
  }

  // Keyless DEMO gate: AKIS_ALLOW_MOCK turns on the deterministic mock provider so a
  // bare `docker compose up` serves a working demo with NO provider key. It is a
  // FALLBACK, not a force — the moment a real key is configured (env or KeyStore) it
  // takes over (the documented "add a key, run real builds" path), so the demo flag
  // never masks a configured key. Fail-closed is preserved: without the flag AND
  // without a key, createProvider still throws (no silent mock).
  const useMock = flag(env.AKIS_ALLOW_MOCK) && !hasRealProviderKey(env, deps.keyStore)

  // Per-user GitHub connection store. start() builds the encrypted JsonFile store (where the
  // master key is in scope); tests/host-injection get an in-memory default here. Threaded into
  // BOTH buildServices calls so the per-owner push override (`githubFor`) is wired identically
  // on the default orchestrator AND every per-workflow orchestrator.
  const connections: GitHubConnectionStore = deps.connections ?? new GitHubConnectionMemoryStore()

  // Build Passport signer (the durable, third-party-verifiable proof of a verified build).
  // From AKIS_PASSPORT_PRIVATE_KEY when configured (Ed25519 PKCS#8 PEM); otherwise a clearly
  // DEV keypair persisted OUTSIDE the repo (AKIS_PASSPORT_KEY_PATH, default ~/.config/akis/
  // passport.json, mode 0600) so the public key is stable across restarts. The PRIVATE key is
  // read here and held ONLY on the signer (never logged/returned — the logger is off, and only
  // signer.publicKey is ever exposed by the read route). Reachable to host injection via
  // deps.services; in the default boot we wire it into buildServices below.
  const passportSigner: PassportSigner = resolvePassportSigner(env)
  if (passportSigner.dev) {
    // eslint-disable-next-line no-console
    console.warn('passport: AKIS_PASSPORT_PRIVATE_KEY unset — using a DEV signing key (set AKIS_PASSPORT_PRIVATE_KEY for a stable, operator-owned key). Public key is published on GET /sessions/:id/passport.')
  }

  // AKIS_RERANK is a default QUALITY toggle (issue #7 AC3), default ON. Only an explicit
  // 0/false disables it (wiring a NoopReranker); anything else leaves the stack default.
  // It is a sibling of the rag flag — never a gate. Returns undefined → use the default.
  const rerankDefault = (): boolean | undefined =>
    env.AKIS_RERANK === undefined ? undefined : flag(env.AKIS_RERANK)
  // Per-upload size ceiling (413 above it). Env override, else the 5 MiB default.
  const uploadMaxBytes = Number(env.AKIS_UPLOAD_MAX_BYTES) > 0 ? Number(env.AKIS_UPLOAD_MAX_BYTES) : DEFAULT_UPLOAD_MAX_BYTES

  // CSRF defense (defense-in-depth, important under AUTH_COOKIE_SAMESITE=none): reject a
  // state-changing request whose browser Origin doesn't match the trusted origin. A
  // missing Origin (non-browser clients, same-origin nav, tests) is not a CSRF vector.
  const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
  const trustedOrigin = env.PUBLIC_BASE_URL?.replace(/\/+$/, '')
  app.addHook('onRequest', async (req, reply) => {
    if (!MUTATING.has(req.method)) return
    const origin = req.headers.origin
    // Enforce only when the trusted origin is configured (behind a dev proxy the host
    // differs from the browser origin, so we can't reliably derive it). A missing Origin
    // (non-browser, same-origin nav, tests) is not a CSRF vector. Dev relies on SameSite=lax.
    if (!trustedOrigin || !origin) return
    if (origin !== trustedOrigin) return reply.code(403).send({ error: 'cross-origin request blocked', code: 'CsrfBlocked' })
  })

  // LAZY boot adapter for the boot-smoke verifier (PR2): the PreviewRegistry is constructed
  // AFTER services (its onStatus emits on services.bus), so the verifier gets a closure that
  // resolves the registry at VERIFY time — runs happen long after boot. FAIL-CLOSED if a
  // verify somehow fires before wiring completes (returns a failed boot → no token).
  let verifyBootImpl: BootSmokeDeps['boot'] | undefined
  const lazyVerifyBoot: BootSmokeDeps['boot'] = async (sessionId, files) =>
    verifyBootImpl ? verifyBootImpl(sessionId, files) : { failed: 'verify boot not wired yet' }

  // One shared orchestrator stack (single store + single bus) across all requests,
  // so the SSE stream observes the same events the command routes produce. The
  // provider resolves via createProvider (fail-closed; mock only under NODE_ENV=test).
  // BOTH env sources (the JsonFileUserStore lesson): a test injecting its own env must
  // still never select the dev file stores.
  const isTestEnv = env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'
  // DEV SESSION PERSISTENCE: builds survive a tsx-watch restart exactly like accounts do
  // (the recurring live pain: a restart wiped in-memory sessions and left frozen views).
  const devPersist = env.NODE_ENV !== 'production' && !isTestEnv
  const services =
    deps.services ??
    buildServices({
      store: deps.sessionStore ?? (devPersist ? new JsonFileSessionStore() : new MockSessionStore()),
      skillsDir: deps.skillsDir ?? defaultSkillsDir(),
      keyStore: deps.keyStore,
      // Thread env unconditionally: the push-adapter selection (P1-CORE-2) reads
      // AKIS_GITHUB_PUSH_TOKEN/REPO here regardless of RAG, and NODE_ENV gates the mock.
      env,
      // Per-user GitHub push override (TIGHTEN-ONLY): a session owner's own connected repo
      // is preferred when present; absent it, the env/mock adapter is used unchanged.
      connections,
      // Opt-in REAL verification: with the boot adapter, Trace BOOTS the produced app and
      // probes the running server (boot-smoke, PR2) — "verified" means it genuinely served.
      ...(flag(env.AKIS_REAL_TESTS) ? { realTests: true, verifyBoot: lazyVerifyBoot } : {}),
      // RAG on → also thread env so a configured AKIS_GITHUB_TOKEN selects the real reader.
      ...(flag(env.AKIS_RAG) ? { rag: true } : {}),
      // Durable corpus: a hydrated PgVectorStore when DATABASE_URL is set (only effective with
      // RAG on); absent it, buildServices uses the in-memory default unchanged.
      ...(flag(env.AKIS_RAG) && deps.vectorStore ? { vectorStore: deps.vectorStore } : {}),
      // Durable lexical half: a Bm25Index hydrated from that same corpus so RRF's BM25 side
      // survives restart (otherwise rebuilt empty); absent it, the in-memory default unchanged.
      ...(flag(env.AKIS_RAG) && deps.bm25 ? { bm25: deps.bm25 } : {}),
      ...(rerankDefault() !== undefined ? { rerank: rerankDefault()! } : {}),
      // Keyless DEMO: run the loop on the deterministic mock provider (no API key).
      // Gated by `useMock` so a configured real key wins over the demo flag.
      ...(useMock ? { provider: new MockProvider() } : {}),
      // Demo verification: a passing mock test runner so a session reaches done+preview
      // WITHOUT real browsers — useful with REAL keys (real Claude output + a complete
      // loop). Implied by AKIS_ALLOW_MOCK. Explicit opt-in only; the default stays
      // fail-closed (real verification still needs AKIS_REAL_TESTS / a real >=1-test pass).
      ...(flag(env.AKIS_ALLOW_MOCK) || flag(env.AKIS_DEMO_VERIFY) ? { testRunner: createMockTestRunner({ testsRun: 2, passed: true }) } : {}),
      // ADDITIVE: a verified build signs a durable Build Passport over its already-minted facts.
      passportSigner,
    })
  // DEV EVENT PERSISTENCE (pairs with the session store above): the bus buffers are what
  // the FE rebuilds its view from (/log replay) — without them a restored session opens as
  // an empty pipeline. Hydrate at boot, persist DEBOUNCED on every emit (buffers are
  // per-session capped, so the file is bounded), and flush once more on close. Best-effort
  // everywhere; only active when the default dev stores are in play (never under tests).
  if (devPersist && !deps.services) {
    const eventsFile = join(homedir(), '.akis', 'dev-events.json')
    try {
      const raw = JSON.parse(readFileSync(eventsFile, 'utf8')) as Parameters<typeof services.bus.hydrate>[0]
      if (raw && typeof raw === 'object') services.bus.hydrate(raw)
    } catch { /* first boot or unreadable — start empty */ }
    let timer: ReturnType<typeof setTimeout> | undefined
    const persistEvents = (): void => {
      try {
        mkdirSync(dirname(eventsFile), { recursive: true })
        writeFileSync(eventsFile, JSON.stringify(services.bus.snapshot()), { mode: 0o600 })
        chmodSync(eventsFile, 0o600)
      } catch { /* best-effort: dev convenience, never a crash */ }
    }
    services.bus.tap(() => { if (timer) clearTimeout(timer); timer = setTimeout(persistEvents, 500); timer.unref?.() })
    app.addHook('onClose', async () => { if (timer) clearTimeout(timer); persistEvents() })
  }
  const orchestrator = deps.orchestrator ?? new Orchestrator(services)
  // Expose the orchestrator services to the host (start()) so graceful shutdown can drain
  // the ingest queue before flushing the corpus write-through + closing the pool. Not part
  // of the public route surface.
  app.decorate('akisServices', services)

  // Preview registry: the registry never spawns until POST /sessions/:id/preview is
  // called; its status changes ride the `preview_status` event so the live UI updates.
  // In demo mode the embedded "running app" is a demo (mock provider/verification), so
  // stamp the lifecycle events with the SAME `demo` signal #59 surfaces on /health
  // (`demo.mode`) — informational only, absent on a live boot (byte-identical).
  const previewRegistry = new PreviewRegistry({
    sandbox: new LocalDirectSandbox(),
    onStatus: e => services.bus.emit({
      kind: 'preview_status', status: e.status,
      ...(e.url !== undefined ? { url: e.url } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      ...(demo.mode === 'demo' ? { demo: true } : {}),
      agent: 'orchestrator', laneId: 'main', sessionId: e.sessionId, ts: nextTs(),
    }),
  })
  // Wire the boot-smoke verifier's boot adapter now that the registry exists (PR2): every
  // verify boots under a unique '<sessionId>#verify-<nonce>' registry entry + tears down.
  verifyBootImpl = makePreviewBoot(previewRegistry)
  // Expose the registry to the host (start()) so graceful shutdown can stopAll() the
  // running previews (kill their process groups + release ports) before the pool closes.
  app.decorate('akisPreviewRegistry', previewRegistry)

  // One shared workflow store (workflow CRUD + session-bound runs use the same one).
  const workflowStore = deps.workflowStore ?? new WorkflowStore()
  const realTests = flag(env.AKIS_REAL_TESTS)
  const demoVerify = flag(env.AKIS_ALLOW_MOCK) || flag(env.AKIS_DEMO_VERIFY)
  // Build a per-session orchestrator that applies a saved workflow (F2-AC9/AC10),
  // sharing the same store + bus so the SSE stream and routes see its run.
  const makeOrchestrator = (wf: WorkflowConfig): Orchestrator => new Orchestrator(buildServices({
    store: services.store, bus: services.bus,
    skillsDir: deps.skillsDir ?? defaultSkillsDir(),
    ...(deps.keyStore ? { keyStore: deps.keyStore } : {}),
    // Thread env unconditionally so the push-adapter selection (P1-CORE-2) sees
    // AKIS_GITHUB_PUSH_TOKEN/REPO + NODE_ENV regardless of RAG.
    env,
    // Same per-user GitHub override on per-workflow orchestrators (one shared store).
    connections,
    ...(useMock ? { provider: new MockProvider() } : {}),
    ...(demoVerify ? { testRunner: createMockTestRunner({ testsRun: 2, passed: true }) } : {}),
    agentModels: workflowToAgentModels(wf),
    // P3-AGENT-1: per-agent selected skills → injected into each core producer's
    // system prompt by buildServices. Empty (the default workflow) ⇒ unchanged prompts.
    agentSkills: workflowToAgentSkills(wf),
    customAgents: workflowCustomAgents(wf),
    ...(wf.iterateBudget !== undefined ? { iterateBudget: wf.iterateBudget } : {}),
    ...(wf.gatePolicy !== undefined ? { gatePolicy: wf.gatePolicy } : {}),
    // When this run enables RAG, also turn it on (env is already threaded above).
    ...(wf.rag !== undefined ? { rag: wf.rag } : {}),
    // Durable corpus for a per-workflow run too: when that run turns RAG on AND a durable
    // store is wired (DATABASE_URL set), use it so the corpus stays shared + persistent. The
    // SAME hydrated BM25 index is shared too, so vector + lexical halves stay in lockstep (they
    // mirror the single shared PgVectorStore — never two divergent lexical views).
    ...(wf.rag && deps.vectorStore ? { vectorStore: deps.vectorStore } : {}),
    ...(wf.rag && deps.bm25 ? { bm25: deps.bm25 } : {}),
    // rerank: the workflow's per-run knob wins (issue #7 AC3); else the env default.
    ...(wf.rerank !== undefined ? { rerank: wf.rerank } : rerankDefault() !== undefined ? { rerank: rerankDefault()! } : {}),
    ...(realTests ? { realTests: true, verifyBoot: lazyVerifyBoot } : {}),
    // Same passport signer as the default orchestrator — one server key signs every run.
    passportSigner,
  }))

  // Auth: JWT-in-cookie (reusing AUTH_JWT_SECRET + AUTH_COOKIE_* from env). Fail CLOSED
  // in production if no secret is set; in dev fall back to a PERSISTED dev secret
  // (~/.akis/dev-secret, created once, 0600) so a tsx-watch restart no longer silently
  // logs the user out on every backend edit (top finding of the reset/state audit).
  // Never used in production (the throw above runs first); not multi-instance safe.
  let authSecret = env.AUTH_JWT_SECRET
  if (!authSecret) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_JWT_SECRET is required in production')
    authSecret = loadOrCreateDevSecret()
  }
  // User persistence default: injected (Pg when DATABASE_URL — see start()) > the DEV
  // file-persisted store > plain in-memory. The file store means a tsx-watch restart no
  // longer DELETES ACCOUNTS in dev ("my signups keep disappearing" — they only ever lived
  // in RAM). NODE_ENV=test keeps the pure in-memory store (no test writes ~/.akis);
  // production never reaches the file store (DATABASE_URL → Pg; persistenceRequired guards).
  // The test guard checks BOTH env sources: integration tests inject their own `env`
  // object (often without NODE_ENV) while vitest sets process.env.NODE_ENV=test — a
  // test must NEVER write the real ~/.akis/dev-users.json.
  const userStore = deps.userStore
    ?? (env.NODE_ENV !== 'production' && !isTestEnv ? new JsonFileUserStore() : new UserStore())

  // OAuth needs a trusted public origin for redirect_uri — don't rely on the client
  // Host header in production. Fail closed if a provider is configured without it.
  if (env.NODE_ENV === 'production' && configuredProviders(env).length > 0 && !env.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is required in production when OAuth providers are configured')
  }

  // Aggregate run analytics via a single global bus tap (observability only).
  const stats = new StatsCollector()
  stats.attach(services.bus)

  // Per-user token QUOTA (multi-tenant safety). The policy is env-driven; budget 0 (default)
  // ⇒ unlimited, so single-operator dev is BYTE-UNCHANGED (checkQuota returns allowed with NO
  // store read). The usage LEDGER mirrors the userStore selection: injected (Pg in start()) >
  // the dev JSON file > pure in-memory (test). A single UsageCollector tap accumulates per-agent
  // token spend onto the owning user (chat usage is accounted off-bus by the chat route).
  const quota = resolveQuotaPolicy(env)
  const usageStore: UsageStorePort = deps.usage
    ?? (env.NODE_ENV !== 'production' && !isTestEnv ? new JsonFileUsageStore(quota.periodMs) : new UsageStore({ periodMs: quota.periodMs }))
  new UsageCollector(usageStore).attach(services.bus)

  const cookie = cookieConfigFromEnv(env)
  // A valid-session guard reused to protect provider-key writes.
  // ASYNC since token revocation: userIdFromRequest now compares the JWT's tv claim to the
  // user record, so every consumer awaits (a revoked token reads as unauthenticated).
  const hasSession = async (req: Parameters<typeof userIdFromRequest>[0]): Promise<boolean> => {
    try { await userIdFromRequest(req, { users: userStore, secret: authSecret, cookie }); return true } catch { return false }
  }
  // Resolve the user id from a request (undefined if unauthenticated) — for per-user history.
  const userIdOf = async (req: Parameters<typeof userIdFromRequest>[0]): Promise<string | undefined> => {
    try { return await userIdFromRequest(req, { users: userStore, secret: authSecret, cookie }) } catch { return undefined }
  }

  // /health surfaces the active serving mode so a demo (fake-verification) boot is never
  // hidden: `mode: 'demo'` means the mock provider and/or mock verification is active and
  // "verified" output is NOT from real tests; `mode: 'live'` is the fail-closed default.
  // `ok` stays true (the HTTP server is healthy) — the FE reads `mode` to surface the badge.
  // ADDITIVE operational signals (no secrets — only counts/uptime/memory) give the operator a
  // view of load/health: uptime, memory, active sessions, live previews, and DB reachability.
  // db:'degraded' after boot keeps ok:true (the server itself is up; boot already fail-closes
  // when persistenceRequired and the pool is unreachable). dbPing absent ⇒ db:'off' (no DATABASE_URL).
  app.get('/health', async () => ({
    ok: true,
    persistence: deps.persistence ?? 'memory',
    mode: demo.mode,
    ...(await buildOpsBlock(stats, previewRegistry, deps.dbPing)),
  }))
  void registerProviderRoutes(app, { keyStore: deps.keyStore, env, requireAuth: hasSession })
  registerSessionRoutes(app, { orchestrator, services, workflowStore, makeOrchestrator, userIdOf, usage: usageStore, quota })
  registerPreviewRoutes(app, { registry: previewRegistry, store: services.store, bus: services.bus })
  // Ship-time preview PREWARM (perceived latency): boot the preview on the `done` event so
  // the first "Run app" click finds it READY. Non-gating, fire-and-forget, kill switch:
  // AKIS_PREVIEW_PREWARM=0. Disabled under test env so route tests keep exact lifecycles.
  if (process.env.AKIS_PREVIEW_PREWARM !== '0' && env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'test') {
    wirePreviewPrewarm(services.bus, services.store, previewRegistry)
  }
  registerWorkflowRoutes(app, { store: workflowStore })
  // Mailer seam (P5-OPS-1): a NoopMailer unless SMTP is configured (default boot unchanged).
  // When a real mailer is configured the reset LINK is emailed (dev-echo suppressed); the
  // emailed link uses PUBLIC_BASE_URL so it is clickable.
  const mailer = deps.mailer ?? selectMailer(env)
  registerAuthRoutes(app, {
    users: userStore, secret: authSecret, cookie, devEcho: env.NODE_ENV !== 'production', mailer,
    ...(trustedOrigin ? { publicBaseUrl: trustedOrigin } : {}),
  })
  registerOAuthRoutes(app, { users: userStore, secret: authSecret, cookie, env })
  // Per-user GitHub connection (connect/status/disconnect). Reuses the SAME userIdOf closure
  // (revocation-aware) so only the authenticated owner reaches their own connection. The
  // connect token is stored in `connections` (encrypted) — NEVER as a session credential.
  registerGitHubConnectRoutes(app, { connections, secret: authSecret, cookie, env, userIdOf })
  registerAnalyticsRoutes(app, { stats })
  // Per-user usage indicator (GET /api/usage; 401 when unauthenticated, mirroring /sessions/mine).
  registerUsageRoutes(app, { usage: usageStore, quota, requireOwner: userIdOf })
  // Operator ops view (GET /api/ops; authenticated via hasSession) — the richer StatsCollector
  // snapshot + the operational block (uptime/memory/activeSessions/livePreviews/db).
  registerOpsRoutes(app, { stats, previewRegistry, requireAuth: hasSession, ...(deps.dbPing ? { dbPing: deps.dbPing } : {}) })
  // Thread env + keyStore so the chat route can resolve a DIFFERENT provider/model PER
  // REQUEST (the model picker), fail-closed like createProvider. Absent any override every
  // chat turn uses services.provider unchanged. CHAT-ONLY: builds keep their workflow bindings.
  // usage/quota/ownerOf add the per-user token gate + off-bus chat accounting (byte-identical
  // when budget 0). ownerOf reuses the revocation-aware userIdOf.
  registerChatRoutes(app, { provider: services.provider, env, ...(deps.keyStore ? { keyStore: deps.keyStore } : {}), usage: usageStore, quota, ownerOf: userIdOf })
  // Knowledge ingestion routes (issue #7) ONLY when the RAG stack is present (AKIS_RAG):
  // the upload/repo sources are surfaced by buildServices only when rag is on, so absent
  // them the route is never registered (404) and there is no behavior change when RAG off.
  if (services.uploadSource && services.repoSource && services.ragUserIdFor) {
    registerKnowledgeRoutes(app, {
      store: services.store,
      uploadSource: services.uploadSource,
      repoSource: services.repoSource,
      ragUserIdFor: services.ragUserIdFor,
      uploadMaxBytes,
      userIdOf,
    })
  }

  // Single-container static serving (self-host): serve the built frontend + own the SPA
  // fallback. Gated behind SERVE_STATIC (or auto when a built dist exists). Registered
  // LAST so it never shadows an API route; the fallback is API-prefix aware. Default
  // (no SERVE_STATIC, no dist) is byte-for-byte unchanged — the plugin is never touched.
  const staticRoot = deps.staticRoot ?? defaultStaticRoot()
  if (staticServingEnabled(env, staticRoot)) registerStatic(app, { root: staticRoot })

  return app
}

/**
 * DEV-ONLY auth secret that SURVIVES restarts: generated once into ~/.akis/dev-secret
 * (0600) and reused on every boot, so a tsx-watch restart no longer silently logs the
 * user out mid-session (the top finding of the reset/state audit). Production never
 * reaches this path (buildServer throws without AUTH_JWT_SECRET there). Fail-open to
 * the old per-boot ephemeral if the file can't be read or written (read-only FS, CI).
 * Exported for tests; `file` is injectable so tests never touch the real home dir.
 */
export function loadOrCreateDevSecret(file = join(homedir(), '.akis', 'dev-secret')): string {
  let existed = false
  try {
    const existing = readFileSync(file, 'utf8').trim()
    existed = true
    // Full strength only: 32 random bytes hex-encode to 64 chars. A shorter (truncated or
    // hand-edited) value must never silently weaken auth — regenerate instead.
    if (existing.length >= 64) return existing
  } catch { /* not created yet (or unreadable) — fall through to create */ }
  if (existed) {
    // An existing-but-invalid file is worth a breadcrumb (silent regeneration = confusing logouts).
    // eslint-disable-next-line no-console
    console.warn('auth: dev-secret file exists but is invalid/short — regenerating')
  }
  const secret = randomBytes(32).toString('hex')
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, secret, { mode: 0o600 })
    chmodSync(file, 0o600) // mode above is masked by umask — chmod makes 0600 unconditional (final review)
    // NOTE: never log the secret; the location is described generically (no interpolation),
    // so aggregated logs don't pinpoint a per-user absolute path.
    // eslint-disable-next-line no-console
    console.warn('auth: AUTH_JWT_SECRET unset — using a persisted dev secret (~/.akis/dev-secret); not multi-instance safe')
  } catch {
    // eslint-disable-next-line no-console
    console.warn('auth: AUTH_JWT_SECRET unset and dev-secret file unwritable — using an ephemeral per-boot secret (sessions reset on restart)')
  }
  return secret
}

/**
 * Resolve the listen host. The default stays loopback (127.0.0.1) for dev SAFETY — the
 * backend is NEVER auto-exposed; a container/host opts in to all-interfaces by setting
 * HOST=0.0.0.0. An empty HOST is treated as unset.
 */
export function resolveListenHost(env: Record<string, string | undefined>): string {
  const host = env.HOST
  return host && host.length > 0 ? host : '127.0.0.1'
}

/**
 * Whether durable persistence is REQUIRED (vs. best-effort). Setting DATABASE_URL is the
 * operator's "persist my data" signal; in production we must not silently degrade to
 * in-memory (which loses users/sessions/workflows on the next restart). True only in
 * production with DATABASE_URL set — dev/self-host keeps the convenient in-memory fallback.
 */
export function persistenceRequired(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === 'production' && !!env.DATABASE_URL
}

/**
 * The serving mode surfaced on /health. `demo` means a fake-verification path is active:
 * the deterministic mock provider and/or mock test verification can let a build reach
 * done+preview WITHOUT real tests — so "verified" output is NOT from a real ≥1-test pass.
 * `live` is the fail-closed default (real provider key + real verification).
 */
export type ServingMode = 'live' | 'demo'

/**
 * Resolve whether the boot is faking verification (demo) and whether that is FATAL.
 *
 * A demo flag is one that can fake verification or force the mock provider:
 *   - AKIS_ALLOW_MOCK   — forces the keyless mock provider AND mock verification
 *   - AKIS_DEMO_VERIFY  — forces a passing mock test runner (real keys, fake tests)
 *
 * FAIL-CLOSED in production (mirrors persistenceRequired): when NODE_ENV=production AND a
 * demo flag is set, the boot is FATAL unless the operator explicitly acknowledges it with
 * AKIS_ALLOW_DEMO_IN_PROD=1 (then it boots but is flagged `demo`). Dev/self-host
 * (non-production) keeps the convenient keyless demo unchanged. With no demo flag the mode
 * is `live` and never fatal.
 */
export function resolveDemoMode(env: Record<string, string | undefined>): { mode: ServingMode; fatal: boolean } {
  const demo = flag(env.AKIS_ALLOW_MOCK) || flag(env.AKIS_DEMO_VERIFY)
  if (!demo) return { mode: 'live', fatal: false }
  const fatal = env.NODE_ENV === 'production' && !flag(env.AKIS_ALLOW_DEMO_IN_PROD)
  return { mode: 'demo', fatal }
}

/** Convenience predicate: a production boot that would fake verification without the
 *  explicit AKIS_ALLOW_DEMO_IN_PROD acknowledgment must refuse to boot. */
export function demoModeFatalInProd(env: Record<string, string | undefined>): boolean {
  return resolveDemoMode(env).fatal
}

/**
 * Resolve the Build Passport signer. Uses AKIS_PASSPORT_PRIVATE_KEY (Ed25519 PKCS#8 PEM) when
 * configured (`dev:false`); otherwise a clearly-DEV keypair persisted OUTSIDE the repo at
 * AKIS_PASSPORT_KEY_PATH (default ~/.config/akis/passport.json, mode 0600 — mirrors the KeyStore
 * path discipline) so the public key is stable across restarts. The PRIVATE key is held ONLY on
 * the returned signer (a KeyObject) — never logged, returned, or placed on a passport.
 */
export function resolvePassportSigner(env: Record<string, string | undefined>): PassportSigner {
  const path = env.AKIS_PASSPORT_KEY_PATH?.trim() || join(homedir(), '.config', 'akis', 'passport.json')
  return loadOrCreatePassportSigner(env, fileDevKeyStore(path))
}

/** The durable stores selected together when DATABASE_URL is set — built over ONE shared
 *  pool whose schema was migrated once. The pool itself is returned so graceful shutdown
 *  can drain it on SIGTERM/SIGINT. */
interface PgStores {
  userStore: UserStorePort
  sessionStore: SessionStore
  workflowStore: WorkflowStorePort
  /** The durable, cross-replica per-user token-usage ledger (the in-memory UsageStore is
   *  per-process; the PgUsageStore UPSERT is the shared source of truth). Created on the SAME
   *  shared pool; the `user_usage` table is created by the shared runMigrations. */
  usageStore: UsageStorePort
  /** The durable RAG corpus, hydrated from the table so a restart re-loads the existing
   *  corpus instead of re-indexing from scratch. */
  vectorStore: PgVectorStore
  /** The BM25 lexical index, hydrated from the SAME persisted corpus so the lexical half of
   *  hybrid retrieval survives a restart too (it was previously rebuilt empty on boot — a
   *  silent correctness bug that degraded RRF to vector-only). */
  bm25: Bm25Index
  pool: SqlClient
}

/**
 * When DATABASE_URL is set, build ONE shared pool, run migrations ONCE, then select the
 * Postgres-backed user/session/workflow stores TOGETHER over that single pool. Returns
 * undefined (and logs) on any failure so the caller falls back to the in-memory default
 * — DEFAULT behavior is never blocked by an unreachable DB.
 *
 * `embeddingDim` sizes the GUARDED real `vector(N)` column (Part B) to the active embedder; the
 * upgrade is best-effort and silently keeps the portable `double precision[]` column where the
 * pgvector extension is unavailable, so this never blocks boot.
 */
async function buildPgStores(connectionString: string, embeddingDim: number, usagePeriodMs: number): Promise<PgStores | undefined> {
  try {
    const pool = await createPgPool(connectionString)
    await runMigrations(pool)
    // Best-effort upgrade the corpus vector column to a real, indexable pgvector(N) typed to the
    // active embedding dim. GUARDED: if the extension is unavailable it leaves double precision[]
    // in place (today's behavior). Run AFTER migrations (table exists) and BEFORE hydrate.
    const pgvector = await ensurePgVectorColumn(pool, embeddingDim)
    // Durable RAG corpus: hydrate the in-memory index from the persisted rows so a restart
    // re-loads the existing corpus (vs. re-indexing). Reads stay synchronous + parity-identical
    // to MemoryVectorStore; writes go through to Postgres. The write-through serializes the
    // embedding to match the actual column type (real vector(N) when the upgrade took, else the
    // portable double precision[]).
    const vectorStore = new PgVectorStore(pool, pgvector.enabled ? 'vector' : 'array')
    await vectorStore.hydrate()
    // Rehydrate the BM25 lexical index from the SAME persisted corpus (one scan, no second
    // query) so RRF's lexical half survives the restart alongside the vector half — previously
    // it was rebuilt EMPTY on boot, silently degrading hybrid retrieval to vector-only.
    const bm25 = new Bm25Index()
    bm25.hydrate(vectorStore.hydratedChunks())
    // eslint-disable-next-line no-console
    console.log(
      `persistence: using Postgres (users + sessions + workflows + RAG corpus); vector column: ${pgvector.enabled ? `pgvector(${embeddingDim})` : 'double precision[] (pgvector extension unavailable)'}`,
    )
    return {
      userStore: createPgUserStoreWithClient(pool),
      sessionStore: new PgSessionStore(pool),
      workflowStore: new PgWorkflowStore(pool),
      usageStore: createPgUsageStoreWithClient(pool, usagePeriodMs),
      vectorStore,
      bm25,
      pool,
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('persistence: Postgres unavailable, using in-memory stores —', (e as Error).message)
    return undefined
  }
}

/** Production entry: build a JSON-file KeyStore from env + listen. */
export async function start(): Promise<void> {
  const master = process.env.AI_KEY_ENCRYPTION_KEY ?? ''
  // Default OUTSIDE the repo so an encrypted key blob can never be committed.
  const file = process.env.AI_KEY_STORE_PATH ?? join(homedir(), '.config', 'akis', 'keys.json')
  const keyStore = new JsonFileKeyStore(file, master)
  // Per-user GitHub connection store, built HERE (where `master` is in scope, exactly like the
  // KeyStore). Same .config/akis dir as the KeyStore default (NOT ~/.akis); 0600 encrypted at
  // rest. Under NODE_ENV=test, the in-memory store (no test writes the real .config/akis).
  const connectionsFile = process.env.AKIS_GITHUB_CONN_STORE_PATH ?? join(homedir(), '.config', 'akis', 'github-connections.json')
  const connections: GitHubConnectionStore = process.env.NODE_ENV !== 'test'
    ? new JsonFileGitHubConnectionStore(connectionsFile, master)
    : new GitHubConnectionMemoryStore()
  // The active embedding dimension (mirrors selectEmbeddingProvider: keyless/test → 256 local;
  // an OpenAI key → the catalog model's dim) sizes the guarded real pgvector(N) column so it
  // matches what is actually stored. Reads env + the SAME KeyStore the embedder consults.
  const embeddingDim = activeEmbeddingDim({ env: process.env as Record<string, string | undefined>, keyStore })
  // The usage-window length sizes the durable PgUsageStore's roll cutoff (the quota POLICY is
  // re-resolved inside buildServer too; here we only need the period for the Pg ledger).
  const usagePeriodMs = resolveQuotaPolicy(process.env as Record<string, string | undefined>).periodMs
  // Durable stores when DATABASE_URL is configured; else in-memory (dev/self-host). One
  // shared pool migrated once backs all of them; on failure buildPgStores returns undefined.
  const pg = process.env.DATABASE_URL ? await buildPgStores(process.env.DATABASE_URL, embeddingDim, usagePeriodMs) : undefined
  // Fail CLOSED in production: if persistence was explicitly requested (DATABASE_URL set)
  // but the DB is unreachable, refuse to boot rather than silently run on in-memory stores
  // and lose data on the next restart. The dev/self-host fallback (no NODE_ENV=production)
  // is preserved — buildPgStores already logged the underlying error.
  if (!pg && persistenceRequired(process.env)) {
    throw new Error(
      'DATABASE_URL is set but Postgres is unreachable — refusing to boot on in-memory stores in production ' +
      '(data would be silently lost on restart). Fix the database, or unset NODE_ENV=production to allow the ' +
      'in-memory fallback.',
    )
  }
  // Reclaim any preview workspaces orphaned by a hard kill (SIGKILL skips graceful
  // teardown). Idempotent + strictly scoped to the workspaces root; best-effort so a
  // stuck dir never blocks boot.
  try { await reclaimWorkspaces() } catch (e) { console.error('preview: workspace reclaim failed:', (e as Error).message) } // eslint-disable-line no-console
  // Bounded DB reachability probe for /health + /api/ops: a cheap `SELECT 1` raced against a
  // 500ms timer so a hot, possibly-unauthenticated probe never blocks on a wedged pool. Only
  // when a pool exists; absent ⇒ db:'off'. ok stays true on a degraded result (the HTTP server
  // is up; boot already fail-closed when persistenceRequired).
  const dbPing = pg
    ? async (): Promise<boolean> => {
        try {
          await Promise.race([
            pg.pool.query('SELECT 1'),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('db ping timeout')), 500)),
          ])
          return true
        } catch { return false }
      }
    : undefined
  const app = buildServer({
    keyStore,
    connections,
    persistence: pg ? 'postgres' : 'memory',
    ...(pg ? { userStore: pg.userStore, sessionStore: pg.sessionStore, workflowStore: pg.workflowStore, usage: pg.usageStore, vectorStore: pg.vectorStore, bm25: pg.bm25 } : {}),
    ...(dbPing ? { dbPing } : {}),
  })
  const port = Number(process.env.PORT ?? 3000)
  const host = resolveListenHost(process.env)
  await app.listen({ port, host })
  // eslint-disable-next-line no-console
  console.log(`AKIS backend on http://${host}:${port}`)

  // Graceful shutdown: on `docker stop` / Ctrl-C, stop accepting connections and let
  // in-flight requests drain (app.close), THEN close the shared Postgres pool, before
  // exiting. Pool teardown is best-effort and last so a clean HTTP drain still happens
  // even if the DB socket is already gone.
  installGracefulShutdown({
    close: async () => {
      await app.close()
      // Stop all running previews (kill their detached process groups + release ports +
      // tear down workspaces) BEFORE the pool closes — orphaned dev servers would otherwise
      // survive the parent and hold loopback ports. Best-effort (stopAll tolerates per-entry
      // errors) so it can't block the rest of a clean shutdown.
      const previewRegistry = (app as FastifyInstance & { akisPreviewRegistry?: PreviewRegistry }).akisPreviewRegistry
      try { await previewRegistry?.stopAll() } catch { /* best-effort */ }
      // Drain the ingest queue FIRST so a chunk enqueued just before shutdown (e.g. the
      // post-push repo auto-ingest) finishes embed→upsert and reaches the write-through
      // chain — otherwise its upsert would run later against an already-closed pool and be
      // lost. THEN settle the write-through, THEN close the pool. Both are best-effort so a
      // stuck ingest/write can never block a clean shutdown.
      const services = (app as FastifyInstance & { akisServices?: OrchestratorServices }).akisServices
      try { await services?.ragQueue?.drain() } catch { /* best-effort */ }
      if (pg?.vectorStore) {
        // eslint-disable-next-line no-console
        try { await pg.vectorStore.flush() } catch (e) { console.error('shutdown: vector flush failed:', (e as Error).message) }
      }
      if (pg?.pool.end) await pg.pool.end()
    },
  })
}
