import Fastify, { type FastifyInstance } from 'fastify'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JsonFileKeyStore, type KeyStore } from '../keys/KeyStore.js'
import { registerProviderRoutes } from './providers.routes.js'
import { registerSessionRoutes } from './sessions.routes.js'
import { registerPreviewRoutes } from './preview.routes.js'
import { buildServices, type OrchestratorServices } from '../di/services.js'
import { Orchestrator } from '../orchestrator/Orchestrator.js'
import { MockSessionStore } from '../store/MockSessionStore.js'
import { PreviewRegistry } from '../preview/PreviewRegistry.js'
import { LocalDirectSandbox } from '../exec/Sandbox.js'
import { nextTs } from '../events/clock.js'

export interface ServerDeps {
  keyStore: KeyStore
  env?: Record<string, string | undefined>
  /** Test/host injection of the orchestrator stack. Built from defaults if omitted. */
  services?: OrchestratorServices
  orchestrator?: Orchestrator
  /** Skills library dir; defaults to the bundled library next to the sources. */
  skillsDir?: string
}

const defaultSkillsDir = (): string =>
  resolve(dirname(fileURLToPath(import.meta.url)), '../skills/library')

/** Build the Fastify app with injected deps (testable via app.inject / listen). */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false }) // logger off: never risk logging key bodies
  const env = deps.env ?? (process.env as Record<string, string | undefined>)

  // One shared orchestrator stack (single store + single bus) across all requests,
  // so the SSE stream observes the same events the command routes produce. The
  // provider resolves via createProvider (fail-closed; mock only under NODE_ENV=test).
  const services =
    deps.services ??
    buildServices({ store: new MockSessionStore(), skillsDir: deps.skillsDir ?? defaultSkillsDir(), keyStore: deps.keyStore })
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

  app.get('/health', async () => ({ ok: true }))
  void registerProviderRoutes(app, { keyStore: deps.keyStore, env })
  registerSessionRoutes(app, { orchestrator, services })
  registerPreviewRoutes(app, { registry: previewRegistry, store: services.store, bus: services.bus })
  return app
}

/** Production entry: build a JSON-file KeyStore from env + listen. */
export async function start(): Promise<void> {
  const master = process.env.AI_KEY_ENCRYPTION_KEY ?? ''
  // Default OUTSIDE the repo so an encrypted key blob can never be committed.
  const file = process.env.AI_KEY_STORE_PATH ?? join(homedir(), '.config', 'akis', 'keys.json')
  const keyStore = new JsonFileKeyStore(file, master)
  const app = buildServer({ keyStore })
  const port = Number(process.env.PORT ?? 3000)
  await app.listen({ port, host: '127.0.0.1' })
  // eslint-disable-next-line no-console
  console.log(`AKIS backend on http://127.0.0.1:${port}`)
}
