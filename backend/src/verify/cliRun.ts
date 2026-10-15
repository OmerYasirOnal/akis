import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import type { Sandbox } from '../exec/Sandbox.js'
import { materialize, teardown } from '../preview/Workspace.js'
import { installSpec } from '../preview/Runner.js'
import type { BddStats, BddScenario } from '../bdd/messageStats.js'
import type { E2eStats, E2eScenario } from '../e2e/playwrightStats.js'
import type { RealRunResult } from './realRun.js'

const EMPTY_BDD: BddStats = { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }
const EMPTY_E2E: E2eStats = { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 }

export interface CliRunDeps {
  sandbox: Sandbox
  timeoutMs?: number
}

/**
 * Shape of the fields we consume from vitest's `--reporter=json` output (empirically confirmed
 * against vitest 2.1.9): top-level test COUNTS + `success`, plus per-test `assertionResults`.
 * Everything else in the report is ignored. Only the counts feed the fail-closed decision.
 */
interface VitestReport {
  numTotalTests?: number
  numPassedTests?: number
  numFailedTests?: number
  numPendingTests?: number
  success?: boolean
  testResults?: Array<{
    assertionResults?: Array<{ title?: string; fullName?: string; status?: string; duration?: number }>
  }>
}

/** Bound a scenario name (mirrors the BDD/E2E 60-char bound elsewhere). */
function boundName(s: string): string {
  return s.trim().slice(0, 60) || 'test'
}

/** A fail-closed CLI result: 0 tests + a bounded reason (surfaced via an e2eScenario so the
 *  structured failure report carries it, exactly like bootSmoke.ts's failClosed). passed:false +
 *  testsRun:0 ⇒ it can NEVER mint a VerifyToken (mint requires testsRun ≥ 1 && passed). */
function failClosed(reason: string): RealRunResult {
  return {
    testsRun: 0,
    passed: false,
    bdd: EMPTY_BDD,
    e2e: EMPTY_E2E,
    bddScenarios: [] as BddScenario[],
    e2eScenarios: [{ name: 'cli tests', passed: false, outcome: boundName(reason) }],
  }
}

/** Read a reporter file at an ABSOLUTE path; missing/garbage → undefined (fail-closed). */
async function readReport(absPath: string): Promise<string | undefined> {
  try { return await readFile(absPath, 'utf8') } catch { return undefined }
}

/**
 * Verify a CLI-shaped project (no server to boot) by RUNNING ITS OWN VITEST SUITE — the honest
 * verification for a project shape that runs once and exits. Mirrors {@link runRealTests}'s
 * FAIL-CLOSED conventions:
 *   1. materialize the produced files into an ephemeral workspace,
 *   2. install deps with lifecycle scripts BLOCKED (the SAME {@link installSpec} the preview path
 *      uses — `pnpm install --ignore-scripts --prefer-offline`), so the install attack surface is
 *      identical to preview/boot,
 *   3. run `pnpm exec vitest run --reporter=json` and parse the JSON report ONLY AFTER the child
 *      exits.
 * A timeout, a missing/unparseable report, or 0 tests ⇒ `passed:false` (so it can never mint a
 * VerifyToken). Returns un-branded stats (a {@link RealRunResult}); the trusted parent brands it.
 *
 * The vitest results populate the BDD half (they are unit-level scenarios, not HTTP E2E); the E2E
 * half stays empty. This is the SAME RealRunResult shape realRun.ts emits, so the boot-smoke runner
 * brands it through the identical buildTestEvidence → mint path with no new minting surface.
 *
 * OWNER-DECISION FLAG (raised independently by two review passes on PR #186): unlike
 * node-service/static verification, where Trace derives its OWN probes/BDD features from the
 * approved spec's acceptance criteria (see realRun.ts's generateFeature + bootSmoke.ts's
 * deriveChecks) — an independent check the producer did not author — the CLI path here has no
 * such independent signal at all: it runs exactly the tests Proto itself wrote (mandated by
 * ProtoAgent.ts rule 6). A CLI VerifyToken therefore means "the producer's own tests, which the
 * producer also wrote, genuinely passed" rather than "an independently-derived check against the
 * approved spec passed." Still fail-closed (never mints on 0 tests / a non-pass / a forged
 * report), but this is a real, intentional narrowing of what "verified" means for this app
 * class, not a bug — flagging it here so it isn't silently assumed equivalent to the other
 * shapes. Building independent spec-derived verification for CLI apps (e.g. probing `--help`
 * output or invoking documented commands) is a separate, larger effort than this bug fix and is
 * deliberately out of scope here.
 */
export async function runCliTests(files: RepoFile[], deps: CliRunDeps): Promise<RealRunResult> {
  const timeoutMs = deps.timeoutMs ?? 120_000
  const dir = await materialize('clirun', files)
  // SECURITY (HIGH): the vitest report is written+read at an ABSOLUTE path in a fresh per-run temp
  // dir OUTSIDE the materialized workspace. Reading it from inside `dir` would let a generated
  // project pre-seed its own FAKE `vitest-report.json` claiming a pass with ZERO real tests — when
  // vitest finds no test files it exits non-zero and does NOT overwrite the output file, so the fake
  // report would survive and mint a token with no test ever run. An out-of-tree, unpredictable path
  // the generated files can neither name nor write into closes that bypass entirely.
  const reportDir = await mkdtemp(join(tmpdir(), 'akis-clirep-'))
  const reportPath = join(reportDir, 'vitest-report.json')
  try {
    // Defensive: never trust a leftover file at the path (a fresh mkdtemp has none, but a reused
    // path must not carry a stale report into this run).
    await rm(reportPath, { force: true }).catch(() => {})

    // Install with lifecycle scripts blocked (same security property as the preview install).
    const inst = installSpec()
    const install = await deps.sandbox.run(inst.cmd, inst.args, { cwd: dir, timeoutMs })
    if (install.timedOut) return failClosed(`cli install timed out after ${timeoutMs}ms`)
    if (install.code !== 0) return failClosed(`cli install failed (code ${install.code})`)

    // Run the project's OWN vitest suite with the JSON reporter → the OUT-OF-TREE report path.
    const run = await deps.sandbox.run('pnpm', ['exec', 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`], { cwd: dir, timeoutMs })
    if (run.timedOut) return failClosed(`cli tests timed out after ${timeoutMs}ms`)

    const raw = await readReport(reportPath)
    if (raw === undefined) return failClosed('cli tests produced no report (0 tests / no test files)')
    let report: VitestReport
    try { report = JSON.parse(raw) as VitestReport } catch { return failClosed('cli test report unparseable') }

    const testsRun = Math.max(0, Math.trunc(report.numTotalTests ?? 0))
    const failed = Math.max(0, Math.trunc(report.numFailedTests ?? 0))
    const passedCount = Math.max(0, Math.trunc(report.numPassedTests ?? 0))
    const skipped = Math.max(0, Math.trunc(report.numPendingTests ?? 0))
    const scenarios: BddScenario[] = []
    let durationMs = 0
    for (const suite of report.testResults ?? []) {
      for (const a of suite.assertionResults ?? []) {
        durationMs += typeof a.duration === 'number' ? a.duration : 0
        const ok = a.status === 'passed'
        scenarios.push({
          name: boundName(a.fullName || a.title || 'test'),
          passed: ok,
          ...(ok ? {} : { failedStatus: (a.status ?? 'failed').toUpperCase() }),
        })
      }
    }

    // FAIL-CLOSED gate — mirrors realRun.ts, plus belt-and-suspenders: a genuinely passing vitest
    // run ALWAYS exits 0, so `run.code === 0` is required to trust a "success" report. This can only
    // TIGHTEN the decision (a genuine test FAILURE still parses its real counts for evidence and is
    // passed:false on `failed`); it never relaxes minting.
    const anyPass = passedCount > 0
    const passed = !run.timedOut && run.code === 0 && testsRun >= 1 && failed === 0 && report.success !== false && anyPass
    const bdd: BddStats = { built: testsRun, run: testsRun, passed: passedCount, failed, skipped, durationMs: Math.round(durationMs) }
    return { testsRun, passed, bdd, e2e: EMPTY_E2E, bddScenarios: scenarios, e2eScenarios: [] as E2eScenario[] }
  } finally {
    await teardown(dir).catch(() => {})
    await rm(reportDir, { recursive: true, force: true }).catch(() => {})
  }
}
