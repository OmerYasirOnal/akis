import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpecArtifact } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import type { Sandbox } from '../exec/Sandbox.js'
import { materialize, teardown } from '../preview/Workspace.js'
import { generateFeature } from '../bdd/featureGen.js'
import { parseCucumberMessages, type BddStats } from '../bdd/messageStats.js'
import { parsePlaywrightReport, type E2eStats } from '../e2e/playwrightStats.js'

const EMPTY_BDD: BddStats = { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }
const EMPTY_E2E: E2eStats = { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 }

const CUC_REPORT = 'cucumber-messages.ndjson'
const PW_REPORT = 'pw-report.json'

export interface RealRunDeps {
  sandbox: Sandbox
  spec?: SpecArtifact
  previewUrl?: string            // baseURL for Playwright (the running preview)
  timeoutMs?: number
  onProgress?: (phase: 'bdd' | 'e2e', stats: BddStats | E2eStats) => void
}

export interface RealRunResult { testsRun: number; passed: boolean; bdd: BddStats; e2e: E2eStats }

/** Read a reporter file written by a child; missing/garbage → undefined (fail-closed). */
async function readReport(dir: string, name: string): Promise<string | undefined> {
  try { return await readFile(join(dir, name), 'utf8') } catch { return undefined }
}

/**
 * Run the BDD (cucumber) + E2E (playwright) suites over the produced files via the
 * Sandbox, parsing each reporter file ONLY AFTER the child exits. FAIL-CLOSED: a
 * timeout, a missing report, or zero tests yields passed=false (so it can never
 * mint a VerifyToken). Returns un-branded stats; the trusted parent
 * (createRealTestRunner) computes the digest and brands the result.
 */
export async function runRealTests(files: RepoFile[], deps: RealRunDeps): Promise<RealRunResult> {
  const timeoutMs = deps.timeoutMs ?? 120_000
  const dir = await materialize('realrun', files)
  try {
    // Generate a feature from the spec's acceptance criteria (always ≥1 scenario).
    if (deps.spec) await writeFile(join(dir, 'features', 'spec.feature'), generateFeature(deps.spec), 'utf8').catch(async () => {
      const { mkdir } = await import('node:fs/promises'); await mkdir(join(dir, 'features'), { recursive: true }); await writeFile(join(dir, 'features', 'spec.feature'), generateFeature(deps.spec!), 'utf8')
    })

    // BDD: cucumber-js with the message (NDJSON) formatter.
    const cuc = await deps.sandbox.run('pnpm', ['exec', 'cucumber-js', '--format', `message:${CUC_REPORT}`], { cwd: dir, timeoutMs })
    const cucJson = await readReport(dir, CUC_REPORT)
    const bdd = cucJson ? parseCucumberMessages(cucJson) : EMPTY_BDD
    deps.onProgress?.('bdd', bdd)

    // E2E: playwright with the JSON reporter; baseURL = the running preview.
    const e2eEnv: Record<string, string> = { PLAYWRIGHT_JSON_OUTPUT_NAME: PW_REPORT }
    if (deps.previewUrl) e2eEnv.PLAYWRIGHT_BASE_URL = deps.previewUrl
    const pw = await deps.sandbox.run('pnpm', ['exec', 'playwright', 'test', '--reporter=json'], { cwd: dir, env: e2eEnv, timeoutMs })
    const pwJson = await readReport(dir, PW_REPORT)
    const e2e = pwJson ? parsePlaywrightReport(pwJson) : EMPTY_E2E
    deps.onProgress?.('e2e', e2e)

    const timedOut = cuc.timedOut || pw.timedOut
    const testsRun = bdd.run + e2e.testsRun
    const anyPass = bdd.passed > 0 || e2e.expected > 0 || e2e.flaky > 0
    const passed = !timedOut && testsRun >= 1 && bdd.failed === 0 && e2e.unexpected === 0 && anyPass
    return { testsRun, passed, bdd, e2e }
  } finally {
    await teardown(dir).catch(() => {})
  }
}
