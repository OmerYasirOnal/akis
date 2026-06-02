/**
 * CONTRACT: dynamic advisory agents (CF4) — AKIS dispatches custom (non-core) agents
 * at the pipeline EDGES, while the 4 structural gates stay intact. Drives the REAL
 * orchestrator + sub-agents (mock provider / deterministic critic).
 */
import { describe, it, expect } from 'vitest'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { buildServices } from '../../src/di/services.js'
import { createMockTestRunner } from '../../src/verify/TestRunner.js'
import { AgentRegistry } from '../../src/agent/dynamic/AgentRegistry.js'
import type { AdvisoryAgent } from '../../src/agent/dynamic/AdvisoryAgent.js'
import { isVerified, type AgentConfig } from '@akis/shared'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

function make(customAgents?: AgentConfig[], advisoryAgents?: AgentRegistry) {
  const store = new MockSessionStore()
  const services = buildServices({
    store, skillsDir,
    mockCriticScore: 90,
    testRunner: createMockTestRunner({ testsRun: 2, passed: true }),
    ...(customAgents ? { customAgents } : {}),
    ...(advisoryAgents ? { advisoryAgents } : {}),
  })
  return { services, orch: new Orchestrator(services) }
}

function texts(services: ReturnType<typeof make>['services'], id: string): string[] {
  return services.bus.recent(id).filter(e => e.kind === 'text').map(e => (e as { text: string }).text)
}

describe('CONTRACT: dynamic advisory agents (CF4)', () => {
  it('dispatches advisory agents at BOTH edges, narrating their notes into the stream', async () => {
    const { orch, services } = make([{ role: 'researcher', tools: ['retrieve_knowledge'] }])
    const s = await orch.start({ idea: 'todo web app' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const t = texts(services, s.id)
    expect(t.some(x => /Advisory \(researcher\/pre_scribe\)/.test(x))).toBe(true)
    expect(t.some(x => /Advisory \(researcher\/post_code_review\)/.test(x))).toBe(true)
  })

  it('keeps the 4 gates intact with advisory agents present (still verifies + ships via trace)', async () => {
    const { orch, services } = make([{ role: 'researcher', tools: ['retrieve_knowledge'] }])
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true)
    // Verification comes from EXACTLY ONE event, and ONLY from trace — advisory
    // agents (no bus/verifier handle) can never mint or duplicate it.
    const verifyEvents = services.bus.recent(s.id).filter(e => e.kind === 'verify')
    expect(verifyEvents).toHaveLength(1)
    expect(verifyEvents.every(e => e.agent === 'trace')).toBe(true)
  })

  it('a THROWING advisor is skipped — the verified pipeline still reaches done (CF4 safety property)', async () => {
    const registry = new AgentRegistry()
    const boom: AdvisoryAgent = { role: 'boom', async advise() { throw new Error('advisor crashed') } }
    registry.register(boom, [])
    const { orch, services } = make(undefined, registry)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    await orch.runToVerification(s.id)
    const done = await orch.confirmPush(s.id)
    expect(done.status).toBe('done')
    expect(isVerified(done)).toBe(true) // a crashing advisor never blocks/alters the spine
    expect(texts(services, s.id).some(t => /Advisory \(boom\) skipped: advisor crashed/.test(t))).toBe(true)
  })

  it('dispatches MULTIPLE custom agents in registration order at an edge', async () => {
    const { orch, services } = make([
      { role: 'researcher', tools: ['retrieve_knowledge'] },
      { role: 'stylist', tools: [] },
    ])
    const s = await orch.start({ idea: 'todo' })
    const pre = texts(services, s.id).filter(t => /\/pre_scribe\)/.test(t))
    const idxR = pre.findIndex(t => /researcher/.test(t))
    const idxS = pre.findIndex(t => /stylist/.test(t))
    expect(idxR).toBeGreaterThanOrEqual(0)
    expect(idxS).toBeGreaterThan(idxR) // researcher dispatched before stylist
  })

  it('never turns a CORE role into an advisory agent, even if it declares tools', async () => {
    const { orch, services } = make([{ role: 'scribe', tools: ['retrieve_knowledge'] }])
    const s = await orch.start({ idea: 'todo' })
    expect(texts(services, s.id).some(t => /Advisory \(scribe\//.test(t))).toBe(false)
  })

  it('REFUSES to build a custom agent that holds a gate capability (runtime enforcement)', () => {
    expect(() => make([{ role: 'rogue', tools: ['run_tests'] }])).toThrow(/gate capability/i)
  })

  it('no custom agents → no advisory narration (zero behavior change)', async () => {
    const { orch, services } = make()
    const s = await orch.start({ idea: 'todo' })
    expect(texts(services, s.id).some(x => /Advisory/.test(x))).toBe(false)
  })
})
