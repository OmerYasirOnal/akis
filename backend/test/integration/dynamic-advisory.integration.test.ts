/**
 * INTEGRATION: the dynamic advisory feature (CF4) is wired end-to-end through the
 * REAL server — NOT an injected orchestrator. Proves the full path:
 *   POST /api/workflows (save a custom advisory agent)
 *     → POST /sessions {workflowId} → server.ts makeOrchestrator(wf)
 *     → buildServices({ customAgents }) → AgentRegistry → Orchestrator.runAdvisory
 *     → advisory narration in GET /sessions/:id/log.
 */
import { describe, it, expect } from 'vitest'
import { buildServer } from '../../src/api/server.js'
import type { KeyStore } from '../../src/keys/KeyStore.js'

const noKeyStore: KeyStore = { status: (p: string) => ({ provider: p, configured: false }), get: () => undefined, set: () => {}, remove: () => {}, list: () => [] }
const env = { AUTH_JWT_SECRET: 'advisory-integration-secret', NODE_ENV: 'test' }

describe('INTEGRATION: dynamic advisory agents wired end-to-end (CF4)', () => {
  it('a workflow with a custom advisory agent dispatches it on a real session start', async () => {
    const app = buildServer({ keyStore: noKeyStore, env })
    try {
      const saved = await app.inject({ method: 'POST', url: '/api/workflows', payload: { name: 'with-advisor', agents: [{ role: 'researcher', tools: ['retrieve_knowledge'] }] } })
      expect(saved.statusCode).toBe(201)
      const wfId = saved.json().id as string
      expect(typeof wfId).toBe('string')

      const created = await app.inject({ method: 'POST', url: '/sessions', payload: { idea: 'a todo app', workflowId: wfId } })
      expect(created.statusCode).toBe(201)
      const sid = created.json().id as string

      const log = await app.inject({ method: 'GET', url: `/sessions/${sid}/log` })
      expect(log.statusCode).toBe(200)
      const events = (log.json().events as { event: { kind: string; text?: string } }[]).map(e => e.event)
      const advisory = events.filter(ev => ev.kind === 'text' && /Advisory \(researcher\/pre_scribe\)/.test(ev.text ?? ''))
      expect(advisory.length).toBeGreaterThan(0) // the advisory agent actually fired via the real server wiring
    } finally {
      await app.close()
    }
  })

  it('a workflow whose custom agent holds a gate capability is REJECTED at save (400)', async () => {
    const app = buildServer({ keyStore: noKeyStore, env })
    try {
      const res = await app.inject({ method: 'POST', url: '/api/workflows', payload: { name: 'rogue', agents: [{ role: 'rogue', tools: ['run_tests'] }] } })
      expect(res.statusCode).toBe(400)
      expect(res.json().errors.join(' ')).toMatch(/gate capability/i)
    } finally {
      await app.close()
    }
  })
})
