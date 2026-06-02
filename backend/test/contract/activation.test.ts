import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { buildServices } from '../../src/di/services.js'
import { Orchestrator } from '../../src/orchestrator/Orchestrator.js'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { MockProvider } from '../../src/agent/providers/mock/MockProvider.js'
import type { Sandbox, RunResult, RunOpts } from '../../src/exec/Sandbox.js'

const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/skills/library')

const PW_PASS = JSON.stringify({ stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0, duration: 10 } })
const CUC_PASS = [
  JSON.stringify({ pickle: { id: 'p1' } }),
  JSON.stringify({ testCaseStarted: { id: 't1' } }),
  JSON.stringify({ testStepFinished: { testCaseStartedId: 't1', testStepResult: { status: 'PASSED' } } }),
  JSON.stringify({ testCaseFinished: { testCaseStartedId: 't1' } }),
].join('\n')

/** Sandbox that writes passing reporter files so the REAL runner verifies. */
const passingSandbox: Sandbox = {
  async run(_c: string, args: string[], opts: RunOpts): Promise<RunResult> {
    if (args.includes('cucumber-js')) await writeFile(join(opts.cwd, 'cucumber-messages.ndjson'), CUC_PASS, 'utf8')
    else if (args.includes('playwright')) await writeFile(join(opts.cwd, 'pw-report.json'), PW_PASS, 'utf8')
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  },
}

let wsRoot: string
beforeAll(async () => { wsRoot = await mkdtemp(join(tmpdir(), 'akis-act-')); process.env.AKIS_WORKSPACES_DIR = wsRoot })
afterAll(() => { delete process.env.AKIS_WORKSPACES_DIR })

describe('activation wiring (sub-project 8)', () => {
  it('realTests opt-in wires the REAL runner → Trace verifies on a real passing run', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider(), realTests: true, sandbox: passingSandbox })
    const token = await services.trace.run({ sessionId: 's1', laneId: 'verify', files: [{ filePath: 'a.ts', content: 'x' }] })
    expect(token).not.toBeNull()
    expect(token!.testsRun).toBeGreaterThanOrEqual(1)
  })

  it('default (no realTests) keeps the fail-closed mock runner → no verification', async () => {
    const services = buildServices({ store: new MockSessionStore(), skillsDir, provider: new MockProvider() })
    const token = await services.trace.run({ sessionId: 's1', laneId: 'verify', files: [{ filePath: 'a.ts', content: 'x' }] })
    expect(token).toBeNull() // mock defaults to 0 tests, fail-closed
  })

  it('iterateBudget actually tightens the runToVerification loop (1 → 1 retry, 3 → 3 retries)', async () => {
    // A critic that APPROVES the spec but REJECTS the code (non-critical) → the
    // orchestrator iterates until the budget, then goes to human resolution.
    const critic = {
      name: 'fake', model: 'm',
      async chat(req: { system: string }): Promise<{ text: string }> {
        const isCode = req.system.toLowerCase().includes('code reviewer')
        return { text: JSON.stringify({ approved: !isCode, overallScore: isCode ? 70 : 90, summary: 'x', findings: [], reviewType: isCode ? 'code_review' : 'spec_review', iteration: 1, hasCriticalFinding: false, maxSeverity: 'info' }) }
      },
    }
    const iterationsFor = async (budget: number): Promise<number> => {
      const store = new MockSessionStore()
      const services = buildServices({ store, skillsDir, provider: critic, iterateBudget: budget })
      const orch = new Orchestrator(services)
      const s = await orch.start({ idea: 'todo' })
      await orch.approve(s.id)
      const done = await orch.runToVerification(s.id)
      expect(done.status).toBe('awaiting_critic_resolution')
      return services.bus.recent(s.id).filter(e => e.kind === 'text' && e.text.includes('Iterating')).length
    }
    expect(await iterationsFor(1)).toBe(1)
    expect(await iterationsFor(3)).toBe(3)
  })

  it('gatePolicy.requireCriticResolution tightens: any code rejection → human resolution, 0 auto-iterations', async () => {
    const critic = {
      name: 'fake', model: 'm',
      async chat(req: { system: string }): Promise<{ text: string }> {
        const isCode = req.system.toLowerCase().includes('code reviewer')
        return { text: JSON.stringify({ approved: !isCode, overallScore: isCode ? 70 : 90, summary: 'x', findings: [], reviewType: isCode ? 'code_review' : 'spec_review', iteration: 1, hasCriticalFinding: false, maxSeverity: 'info' }) }
      },
    }
    const store = new MockSessionStore()
    const services = buildServices({ store, skillsDir, provider: critic, iterateBudget: 3, gatePolicy: { requireCriticResolution: true } })
    const orch = new Orchestrator(services)
    const s = await orch.start({ idea: 'todo' })
    await orch.approve(s.id)
    const done = await orch.runToVerification(s.id)
    expect(done.status).toBe('awaiting_critic_resolution')
    // No auto-iteration despite budget 3 — the policy forced resolution on first rejection.
    expect(services.bus.recent(s.id).filter(e => e.kind === 'text' && e.text.includes('Iterating')).length).toBe(0)
  })
})
