import Fastify, { type FastifyInstance } from 'fastify'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { JsonFileKeyStore, type KeyStore } from '../keys/KeyStore.js'
import { registerProviderRoutes } from './providers.routes.js'

export interface ServerDeps {
  keyStore: KeyStore
  env?: Record<string, string | undefined>
}

/** Build the Fastify app with injected deps (testable via app.inject). */
export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false }) // logger off: never risk logging key bodies
  app.get('/health', async () => ({ ok: true }))
  void registerProviderRoutes(app, { keyStore: deps.keyStore, env: deps.env ?? (process.env as Record<string, string | undefined>) })
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
