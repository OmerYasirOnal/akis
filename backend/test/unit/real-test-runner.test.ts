import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRealTestRunner } from '../../src/verify/TestRunner.js'
import { digestFiles } from '../../src/verify/digest.js'
import type { Sandbox, RunResult, RunOpts } from '../../src/exec/Sandbox.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

const FILES: RepoFile[] = [{ filePath: 'index.ts', content: 'export const app = 1' }]

const PW_PASS = JSON.stringify({ stats: { expected: 2, unexpected: 0, flaky: 0, skipped: 0, duration: 100 } })
const PW_FAIL = JSON.stringify({ stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 50 } })
const CUC_PASS = [
  JSON.stringify({ pickle: { id: 'p1' } }),
  JSON.stringify({ testCaseStarted: { id: 't1' } }),
  JSON.stringify({ testStepFinished: { testCaseStartedId: 't1', testStepResult: { status: 'PASSED' } } }),
  JSON.stringify({ testCaseFinished: { testCaseStartedId: 't1' } }),
].join('\n')

/** A programmable sandbox: writes the given report file into cwd, then returns the result. */
function reportingSandbox(plan: { cucumber?: { report?: string; result: RunResult }; playwright?: { report?: string; result: RunResult } }): Sandbox {
  return {
    async run(_cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
      const isCuc = args.includes('cucumber-js')
      const step = isCuc ? plan.cucumber : plan.playwright
      if (step?.report !== undefined) {
        const name = isCuc ? 'cucumber-messages.ndjson' : 'pw-report.json'
        await writeFile(join(opts.cwd, name), step.report, 'utf8')
      }
      return step?.result ?? { code: 1, stdout: '', stderr: '', timedOut: false }
    },
  }
}

let wsRoot: string
beforeAll(async () => { wsRoot = await mkdtemp(join(tmpdir(), 'akis-rr-')); process.env.AKIS_WORKSPACES_DIR = wsRoot })
afterAll(() => { delete process.env.AKIS_WORKSPACES_DIR })

const ok: RunResult = { code: 0, stdout: '', stderr: '', timedOut: false }

describe('createRealTestRunner', () => {
  it('mints a passing result on real reporter output, with a PARENT-computed digest', async () => {
    const sb = reportingSandbox({ cucumber: { report: CUC_PASS, result: ok }, playwright: { report: PW_PASS, result: ok } })
    const runner = createRealTestRunner({ sandbox: sb })
    const res = await runner.run(FILES)
    expect(res.passed).toBe(true)
    expect(res.testsRun).toBeGreaterThanOrEqual(1)
    expect(res.codeDigest).toBe(digestFiles(FILES)) // digest is the parent's, over the exact files
  })

  it('fail-closed: a Playwright unexpected failure → not passed, testsRun 0', async () => {
    const sb = reportingSandbox({ cucumber: { report: CUC_PASS, result: ok }, playwright: { report: PW_FAIL, result: { code: 1, stdout: '', stderr: '', timedOut: false } } })
    const res = await createRealTestRunner({ sandbox: sb }).run(FILES)
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
  })

  it('fail-closed: a timeout → not passed (even if a partial report exists)', async () => {
    const sb = reportingSandbox({ cucumber: { report: CUC_PASS, result: { code: null, stdout: '', stderr: '', timedOut: true } }, playwright: { report: PW_PASS, result: { code: null, stdout: '', stderr: '', timedOut: true } } })
    const res = await createRealTestRunner({ sandbox: sb }).run(FILES)
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
  })

  it('fail-closed: missing reporter files → 0 tests, not passed', async () => {
    const sb = reportingSandbox({ cucumber: { result: ok }, playwright: { result: ok } }) // no reports written
    const res = await createRealTestRunner({ sandbox: sb }).run(FILES)
    expect(res.passed).toBe(false)
    expect(res.testsRun).toBe(0)
  })
})
