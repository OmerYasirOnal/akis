/**
 * Smoke run — drives the full agentic flow on the mock provider and prints the
 * live event timeline. Demonstrates (1) the happy path ending done/verified and
 * (2) the vacuous-green guard ending ⚠️ (not verified → push blocked).
 *
 * Run: pnpm -C backend smoke
 */
import { Orchestrator } from '../src/orchestrator/Orchestrator.js'
import { MockProvider } from '../src/agent/mock/MockProvider.js'
import { MockSessionStore } from '../src/store/MockSessionStore.js'
import { buildServices } from '../src/di/services.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AkisEvent } from '@akis/shared'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/skills/library')

function line(e: AkisEvent): string {
  const head = `  [${e.laneId}] ${e.agent} · ${e.kind}`
  if (e.kind === 'text') return `${head}: ${e.text}`
  if (e.kind === 'gate') return `${head}: ${e.gate} (${e.state})`
  if (e.kind === 'verify') return `${head}: testsRun=${e.testsRun} passed=${e.passed}`
  if (e.kind === 'done') return `${head}: verified=${e.verified}`
  if (e.kind === 'error') return `${head}: ${e.message}`
  return head
}

async function run(label: string, knobs: Record<string, unknown>): Promise<void> {
  console.log(`\n=== ${label} ===`)
  const provider = new MockProvider({ script: [{ text: 'ok' }], knobs: { mockCriticScore: 90, mockTraceTestCount: 2, ...knobs } })
  const services = buildServices({ provider, store: new MockSessionStore(), skillsDir })
  const orch = new Orchestrator(services)
  const s = await orch.start({ idea: 'build a todo web app' })
  services.bus.subscribe(s.id, e => console.log(line(e)))
  // replay the events already emitted before we subscribed
  for (const e of services.bus.recent(s.id)) console.log(line(e))

  await orch.approve(s.id)
  await orch.runToVerification(s.id)
  try {
    const done = await orch.confirmPush(s.id)
    console.log(`RESULT: ${done.status} · verified=${done.verified} ✅`)
  } catch (e) {
    console.log(`RESULT: blocked — ${(e as Error).name} (correct: vacuous green ⚠️)`)
  }
}

await run('HAPPY PATH', {})
await run('VACUOUS GREEN (0 tests)', { mockTraceTestCount: 0 })
console.log('\nSmoke complete.')
