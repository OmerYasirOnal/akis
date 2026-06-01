/**
 * Smoke run — drives the full flow on the mock and prints the live event
 * timeline. Demonstrates (1) the happy path ending done/verified and (2) the
 * vacuous-green guard ending ⚠️ (no real test → not verified → push blocked).
 *
 * Run: pnpm -C backend smoke
 */
import { Orchestrator } from '../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../src/store/MockSessionStore.js'
import { buildServices } from '../src/di/services.js'
import { createMockTestRunner } from '../src/verify/TestRunner.js'
import { isVerified } from '@akis/shared'
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

async function run(label: string, testsRun: number): Promise<void> {
  console.log(`\n=== ${label} ===`)
  const services = buildServices({
    store: new MockSessionStore(), skillsDir,
    mockCriticScore: 90,
    testRunner: createMockTestRunner({ testsRun, passed: testsRun > 0 }),
  })
  const orch = new Orchestrator(services)
  const s = await orch.start({ idea: 'build a todo web app' })
  services.bus.subscribe(s.id, e => console.log(line(e)))
  for (const e of services.bus.recent(s.id)) console.log(line(e)) // replay pre-subscribe events

  await orch.approve(s.id)
  await orch.runToVerification(s.id)
  try {
    const done = await orch.confirmPush(s.id)
    console.log(`RESULT: ${done.status} · verified=${isVerified(done)} ✅`)
  } catch (e) {
    console.log(`RESULT: blocked — ${(e as Error).name} (correct: vacuous green ⚠️)`)
  }
}

await run('HAPPY PATH', 2)
await run('VACUOUS GREEN (0 tests)', 0)
console.log('\nSmoke complete.')
