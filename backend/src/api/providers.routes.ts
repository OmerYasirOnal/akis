import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { KeyStore } from '../keys/KeyStore.js'
import { CATALOG, REAL_PROVIDERS, type ProviderId } from '../agent/providers/catalog.js'

export interface ProvidersDeps {
  keyStore: KeyStore
  env: Record<string, string | undefined>
  /** Optional auth guard for write endpoints: returns true if the request is a valid
   *  session. When provided, setting/removing a provider key requires authentication. */
  requireAuth?: (req: FastifyRequest) => boolean | Promise<boolean>
}

function envKeyPresent(env: Record<string, string | undefined>, provider: Exclude<ProviderId, 'mock'>): boolean {
  // HONESTY FIX: also honour the generic AI_API_KEY fallback that createProvider resolves
  // (firstPresentKey ?? AI_API_KEY ?? keyStore). Without this, a self-host whose only key is the
  // generic AI_API_KEY (the common shared/ready-key case) ran real builds while the model chip
  // falsely showed "NO KEY" — the env key the server is actually using was invisible to the UI.
  return CATALOG[provider].keyEnvVars.some(v => !!env[v]) || !!env.AI_API_KEY
}

/**
 * Provider availability + key endpoints. Availability = an env key is present OR
 * the KeyStore has a (decryptable) key. Responses never include the key or
 * ciphertext — only `last4` + `configured`. Request bodies are never logged.
 */
export async function registerProviderRoutes(app: FastifyInstance, deps: ProvidersDeps): Promise<void> {
  app.get('/api/providers', async () => {
    return REAL_PROVIDERS.map(id => {
      const info = CATALOG[id]
      const status = deps.keyStore.status(id)
      const available = envKeyPresent(deps.env, id) || status.configured
      return {
        id,
        label: info.label,
        available,
        defaultModel: info.defaultModel,
        models: info.models,
        ...(status.last4 ? { last4: status.last4 } : {}),
        ...(status.updatedAt ? { updatedAt: status.updatedAt } : {}),
      }
    })
  })

  app.put<{ Params: { provider: string }; Body: { apiKey?: string } }>(
    '/api/providers/:provider/key',
    async (req, reply) => {
      if (deps.requireAuth && !(await deps.requireAuth(req))) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
      const provider = req.params.provider
      if (!(REAL_PROVIDERS as string[]).includes(provider)) {
        return reply.code(400).send({ error: 'unknown provider' })
      }
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : ''
      if (!apiKey) return reply.code(400).send({ error: 'apiKey required' })
      deps.keyStore.set(provider, apiKey)
      return { provider, last4: apiKey.slice(-4) } // never echoes the key
    },
  )

  app.delete<{ Params: { provider: string } }>(
    '/api/providers/:provider/key',
    async (req, reply) => {
      if (deps.requireAuth && !(await deps.requireAuth(req))) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
      const provider = req.params.provider
      if (!(REAL_PROVIDERS as string[]).includes(provider)) {
        return reply.code(400).send({ error: 'unknown provider' })
      }
      deps.keyStore.remove(provider)
      return { provider, removed: true }
    },
  )
}
