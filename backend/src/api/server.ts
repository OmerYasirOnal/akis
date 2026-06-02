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
import { registerAuthRoutes } from './auth.routes.js'
import { UserStore, type UserStorePort } from '../auth/UserStore.js'
import { createPgUserStore } from '../auth/PgUserStore.js'
import { cookieConfigFromEnv } from '../auth/cookie.js'
import { registerAnalyticsRoutes } from './analytics.routes.js'
import { StatsCollector } from '../analytics/StatsCollector.js'
import { registerChatRoutes } from './chat.routes.js'
import { registerOAuthRoutes } from './oauth.routes.js'
import { configuredProviders } from '../auth/oauth.js'
import { WorkflowStore } from '../workflow/WorkflowStore.js'
import { workflowToAgentModels } from '../workflow/resolve.js'
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
    ...(wf.iterateBudget !== undefined ? { iterateBudget: wf.iterateBudget } : {}),
    ...(wf.gatePolicy !== undefined ? { gatePolicy: wf.gatePolicy } : {}),
    ...(wf.rag !== undefined ? { rag: wf.rag } : {}),
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

  app.get('/health', async () => ({ ok: true }))
  void registerProviderRoutes(app, { keyStore: deps.keyStore, env })
  registerSessionRoutes(app, { orchestrator, services, workflowStore, makeOrchestrator })
  registerPreviewRoutes(app, { registry: previewRegistry, store: services.store, bus: services.bus })
  registerWorkflowRoutes(app, { store: workflowStore })
  registerAuthRoutes(app, { users: userStore, secret: authSecret, cookie: cookieConfigFromEnv(env), devEcho: env.NODE_ENV !== 'production' })
  registerOAuthRoutes(app, { users: userStore, secret: authSecret, cookie: cookieConfigFromEnv(env), env })
  registerAnalyticsRoutes(app, { stats })
  registerChatRoutes(app, { provider: services.provider })
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
