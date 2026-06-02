import Fastify, { type FastifyInstance } from 'fastify'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonFileKeyStore, type KeyStore } from '../keys/KeyStore.js'
import { randomBytes } from 'node:crypto'
import { registerProviderRoutes } from './providers.routes.js'
import { registerSessionRoutes } from './sessions.routes.js'
import { registerPreviewRoutes } from './preview.routes.js'
import { registerWorkflowRoutes } from './workflows.routes.js'
import { registerAuthRoutes, userIdFromRequest } from './auth.routes.js'
import { UserStore, type UserStorePort } from '../auth/UserStore.js'
import { createPgUserStore } from '../auth/PgUserStore.js'
import { cookieConfigFromEnv } from '../auth/cookie.js'
import { registerAnalyticsRoutes } from './analytics.routes.js'
import { StatsCollector } from '../analytics/StatsCollector.js'
import { registerChatRoutes } from './chat.routes.js'
import { registerKnowledgeRoutes, DEFAULT_UPLOAD_MAX_BYTES } from './knowledge.routes.js'
import { registerOAuthRoutes } from './oauth.routes.js'
import { configuredProviders } from '../auth/oauth.js'
import { WorkflowStore } from '../workflow/WorkflowStore.js'
import { workflowToAgentModels, workflowCustomAgents } from '../workflow/resolve.js'
import type { WorkflowConfig } from '@akis/shared'
import { buildServices, type OrchestratorServices } from '../di/services.js'
import { Orchestrator } from '../orchestrator/Orchestrator.js'
import { MockSessionStore } from '../store/MockSessionStore.js'
import { PreviewRegistry } from '../preview/PreviewRegistry.js'
import { LocalDirectSandbox } from '../exec/Sandbox.js'
import { MockProvider } from '../agent/providers/mock/MockProvider.js'
import { createMockTestRunner } from '../verify/TestRunner.js'
import { nextTs } from '../events/clock.js'

export interface ServerDeps {
  keyStore: KeyStore
  env?: Record<string, string | undefined>
  /** Test/host injection of the orchestrator stack. Built from defaults if omitted. */
  services?: OrchestratorServices
  orchestrator?: Orchestrator
  /** Skills library dir; defaults to the bundled library next to the sources. */
  skillsDir?: string
  /** Workflow preset store (in-memory by default; injectable for tests/persistence). */
  workflowStore?: WorkflowStore
  /** User store for auth (in-memory by default; a PgUserStore when DATABASE_URL is set). */
  userStore?: UserStorePort
}

const defaultSkillsDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../skills/library')

const flag = (v: string | undefined): boolean => v === '1' || v === 'true'

/** Build the Fastify app with injected deps (testable via app.inject / listen). */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false }) // logger off: never risk logging key bodies
  const env = deps.env ?? (process.env as Record<string, string | undefined>)

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

  // One shared orchestrator stack (single store + single bus) across all requests,
  // so the SSE stream observes the same events the command routes produce. The
  // provider resolves via createProvider (fail-closed; mock only under NODE_ENV=test).
  const services =
    deps.services ??
    buildServices({
      store: new MockSessionStore(),
      skillsDir: deps.skillsDir ?? defaultSkillsDir(),
      keyStore: deps.keyStore,
      // Opt-in real Playwright+Cucumber verification (browsers required); mock default.
      ...(flag(env.AKIS_REAL_TESTS) ? { realTests: true } : {}),
      ...(flag(env.AKIS_RAG) ? { rag: true } : {}),
      ...(rerankDefault() !== undefined ? { rerank: rerankDefault()! } : {}),
      // Keyless DEMO: run the loop on the deterministic mock provider (no API key).
      ...(flag(env.AKIS_ALLOW_MOCK) ? { provider: new MockProvider() } : {}),
      // Demo verification: a passing mock test runner so a session reaches done+preview
      // WITHOUT real browsers — useful with REAL keys (real Claude output + a complete
      // loop). Implied by AKIS_ALLOW_MOCK. Explicit opt-in only; the default stays
      // fail-closed (real verification still needs AKIS_REAL_TESTS / a real >=1-test pass).
      ...(flag(env.AKIS_ALLOW_MOCK) || flag(env.AKIS_DEMO_VERIFY) ? { testRunner: createMockTestRunner({ testsRun: 2, passed: true }) } : {}),
    })
  const orchestrator = deps.orchestrator ?? new Orchestrator(services)

  // Preview registry: the registry never spawns until POST /sessions/:id/preview is
  // called; its status changes ride the `preview_status` event so the live UI updates.
  const previewRegistry = new PreviewRegistry({
    sandbox: new LocalDirectSandbox(),
    onStatus: e => services.bus.emit({
      kind: 'preview_status', status: e.status,
      ...(e.url !== undefined ? { url: e.url } : {}),
      ...(e.reason !== undefined ? { reason: e.reason } : {}),
      agent: 'orchestrator', laneId: 'main', sessionId: e.sessionId, ts: nextTs(),
    }),
  })

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
    ...(flag(env.AKIS_ALLOW_MOCK) ? { provider: new MockProvider() } : {}),
    ...(demoVerify ? { testRunner: createMockTestRunner({ testsRun: 2, passed: true }) } : {}),
    agentModels: workflowToAgentModels(wf),
    customAgents: workflowCustomAgents(wf),
    ...(wf.iterateBudget !== undefined ? { iterateBudget: wf.iterateBudget } : {}),
    ...(wf.gatePolicy !== undefined ? { gatePolicy: wf.gatePolicy } : {}),
    ...(wf.rag !== undefined ? { rag: wf.rag } : {}),
    // rerank: the workflow's per-run knob wins (issue #7 AC3); else the env default.
    ...(wf.rerank !== undefined ? { rerank: wf.rerank } : rerankDefault() !== undefined ? { rerank: rerankDefault()! } : {}),
    ...(realTests ? { realTests: true } : {}),
  }))

  // Auth: JWT-in-cookie (reusing AUTH_JWT_SECRET + AUTH_COOKIE_* from env). Fail CLOSED
  // in production if no secret is set; in dev fall back to an ephemeral per-boot secret
  // (with a clear warning) so local work isn't blocked — sessions just reset on restart
  // and it is not multi-instance safe.
  let authSecret = env.AUTH_JWT_SECRET
  if (!authSecret) {
    if (env.NODE_ENV === 'production') throw new Error('AUTH_JWT_SECRET is required in production')
    authSecret = randomBytes(32).toString('hex')
    // eslint-disable-next-line no-console
    console.warn('auth: AUTH_JWT_SECRET unset — using an ephemeral per-boot secret (sessions reset on restart; not multi-instance safe)')
  }
  const userStore = deps.userStore ?? new UserStore()

  // OAuth needs a trusted public origin for redirect_uri — don't rely on the client
  // Host header in production. Fail closed if a provider is configured without it.
  if (env.NODE_ENV === 'production' && configuredProviders(env).length > 0 && !env.PUBLIC_BASE_URL) {
    throw new Error('PUBLIC_BASE_URL is required in production when OAuth providers are configured')
  }

  // Aggregate run analytics via a single global bus tap (observability only).
  const stats = new StatsCollector()
  stats.attach(services.bus)

  const cookie = cookieConfigFromEnv(env)
  // A valid-session guard reused to protect provider-key writes.
  const hasSession = (req: Parameters<typeof userIdFromRequest>[0]): boolean => {
    try { userIdFromRequest(req, { users: userStore, secret: authSecret, cookie }); return true } catch { return false }
  }
  // Resolve the user id from a request (undefined if unauthenticated) — for per-user history.
  const userIdOf = (req: Parameters<typeof userIdFromRequest>[0]): string | undefined => {
    try { return userIdFromRequest(req, { users: userStore, secret: authSecret, cookie }) } catch { return undefined }
  }

  app.get('/health', async () => ({ ok: true }))
  void registerProviderRoutes(app, { keyStore: deps.keyStore, env, requireAuth: hasSession })
  registerSessionRoutes(app, { orchestrator, services, workflowStore, makeOrchestrator, userIdOf })
  registerPreviewRoutes(app, { registry: previewRegistry, store: services.store, bus: services.bus })
  registerWorkflowRoutes(app, { store: workflowStore })
  registerAuthRoutes(app, { users: userStore, secret: authSecret, cookie, devEcho: env.NODE_ENV !== 'production' })
  registerOAuthRoutes(app, { users: userStore, secret: authSecret, cookie, env })
  registerAnalyticsRoutes(app, { stats })
  registerChatRoutes(app, { provider: services.provider })
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
  return app
}

/** Production entry: build a JSON-file KeyStore from env + listen. */
export async function start(): Promise<void> {
  const master = process.env.AI_KEY_ENCRYPTION_KEY ?? ''
  // Default OUTSIDE the repo so an encrypted key blob can never be committed.
  const file = process.env.AI_KEY_STORE_PATH ?? join(homedir(), '.config', 'akis', 'keys.json')
  const keyStore = new JsonFileKeyStore(file, master)
  // Durable user store when DATABASE_URL is configured; else in-memory (dev/self-host).
  let userStore: UserStorePort | undefined
  if (process.env.DATABASE_URL) {
    try { userStore = await createPgUserStore(process.env.DATABASE_URL); console.log('auth: using Postgres user store') }
    catch (e) { console.error('auth: Postgres unavailable, using in-memory store —', (e as Error).message) }
  }
  const app = buildServer({ keyStore, ...(userStore ? { userStore } : {}) })
  const port = Number(process.env.PORT ?? 3000)
  await app.listen({ port, host: '127.0.0.1' })
  // eslint-disable-next-line no-console
  console.log(`AKIS backend on http://127.0.0.1:${port}`)
}
