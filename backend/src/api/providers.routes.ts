import type { FastifyInstance } from 'fastify'
import type { KeyStore } from '../keys/KeyStore.js'
import { CATALOG, REAL_PROVIDERS, type ProviderId } from '../agent/providers/catalog.js'

export interface ProvidersDeps {
  keyStore: KeyStore
  env: Record<string, string | undefined>
}

function envKeyPresent(env: Record<string, string | undefined>, provider: Exclude<ProviderId, 'mock'>): boolean {
  return CATALOG[provider].keyEnvVars.some(v => !!env[v])
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
      const provider = req.params.provider
      if (!(REAL_PROVIDERS as string[]).includes(provider)) {
        return reply.code(400).send({ error: 'unknown provider' })
      }
      deps.keyStore.remove(provider)
      return { provider, removed: true }
    },
  )
}
