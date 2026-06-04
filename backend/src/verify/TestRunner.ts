import type { TestEvidence } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import { digestFiles, digestEvidence } from './digest.js'
import { buildTestEvidence } from './evidence.js'

/**
 * Evidence of a real test execution.
 *
 * NOMINAL BRAND: the brand key is a `unique symbol` private to THIS module, so a
 * TestRunResult cannot be constructed as a literal anywhere else (not even with
 * `as TestRunResult`). Only `brandResult` applies it, and only `run()` here calls
 * it. A producer module cannot fabricate test evidence; it can only obtain one by
 * actually invoking a runner over real files.
 *
 * The result carries `codeDigest` computed BY THE RUNNER from the files it ran,
 * so the verification evidence is bound to the exact tested code — a caller
 * cannot substitute a different digest. It ALSO carries `evidenceDigest`, the
 * length-prefixed digest of the STRUCTURED test evidence the runner computed (the
 * SAME value it reports via `onEvidence`). That is purely DERIVED + additive — it is
 * computed alongside, and never feeds, the fail-closed pass decision below — so it
 * makes "passed N tests" tamper-evident at the same structural rigor as `codeDigest`
 * WITHOUT ever relaxing minting.
 *
 * Honest boundary (documented, deliberately deferred per spec §1): in a single
 * process, TypeScript cannot prevent a same-graph module from importing a runner
 * and calling it. The structural guarantees here are: (1) no literal/accidental
 * forgery of a result, (2) the production wiring grants the runner only to Trace
 * (asserted by the DI-wiring test), (3) fail-closed minting, (4) evidence bound
 * to a runner-computed digest. A hard trust boundary (separate verifier process
 * / role isolation) is a later sub-project.
 */
declare const resultBrand: unique symbol

export type TestRunResult = {
  readonly [resultBrand]: true
  readonly testsRun: number
  readonly passed: boolean
  readonly codeDigest: string
  /** Tamper-evidence digest of the STRUCTURED evidence (see digestEvidence). DERIVED +
   *  additive: computed alongside, never feeding, the pass decision the verifier mints from. */
  readonly evidenceDigest: string
}

function brandResult(testsRun: number, passed: boolean, codeDigest: string, evidenceDigest: string): TestRunResult {
  return { testsRun, passed, codeDigest, evidenceDigest } as unknown as TestRunResult
}

/**
 * ADDITIVE, NON-GATE options for a run. `onEvidence` is an observability sink: the
 * runner reports the structured {@link TestEvidence} it computed alongside (NEVER
 * feeding) the fail-closed pass/fail decision. It is purely a side-channel — it
 * cannot alter the branded {@link TestRunResult} (which stays `{ testsRun, passed,
 * codeDigest }`), so the gate truth is byte-identical whether or not it is supplied.
 */
export interface RunOptions {
  onEvidence?: (evidence: TestEvidence) => void
}

export interface TestRunner {
  run(files: RepoFile[], opts?: RunOptions): Promise<TestRunResult>
}

export interface TestRunConfig {
  testsRun: number
  passed: boolean
}

/**
 * Deterministic runner for the mock sub-project. Configured EXPLICITLY (not read
 * off a provider). FAIL-CLOSED default: zero tests / not passed, so a real
 * provider with no real runner injected can NEVER auto-verify. The digest is
 * computed from the actual files passed to run(). Real test execution arrives
 * later behind this same interface.
 */
class MockTestRunnerImpl implements TestRunner {
  constructor(private readonly cfg: TestRunConfig = { testsRun: 0, passed: false }) {}
  async run(files: RepoFile[], opts?: RunOptions): Promise<TestRunResult> {
    // ADDITIVE: synthesize structured evidence from the deterministic config so the
    // mock/demo path ALSO surfaces persisted evidence (one synthetic BDD scenario per
    // configured test). This never touches the fail-closed pass decision below.
    const evidence = synthMockEvidence(this.cfg)
    opts?.onEvidence?.(evidence)
    // evidenceDigest is DERIVED from the SAME evidence reported above — purely additive,
    // bound onto the result so the recorded verification is tamper-evident.
    return brandResult(this.cfg.testsRun, this.cfg.passed, digestFiles(files), digestEvidence(evidence))
  }
}

/** Build structured evidence for the mock/demo runner from its config — one synthetic
 *  BDD scenario per configured test, all passing iff the run passed. Observability
 *  only; the branded result is computed independently. */
function synthMockEvidence(cfg: TestRunConfig): TestEvidence {
  const n = Math.max(0, Math.trunc(cfg.testsRun))
  const bddScenarios = Array.from({ length: n }, (_, i) => ({
    name: `mock scenario ${i + 1}`,
    passed: cfg.passed,
    ...(cfg.passed ? {} : { failedStatus: 'FAILED', failedStep: 'step reported FAILED' }),
  }))
  return buildTestEvidence({
    passed: cfg.passed,
    bdd: { built: n, run: n, passed: cfg.passed ? n : 0, failed: cfg.passed ? 0 : n, skipped: 0, durationMs: 0 },
    e2e: { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 },
    bddScenarios,
    e2eScenarios: [],
  })
}

/**
 * Factory for the mock runner. The class itself stays module-private; callers get
 * a `TestRunner` interface, not a constructable forging tool. (Real runners
 * implement the same interface in a later sub-project, behind a sandbox.)
 */
export function createMockTestRunner(cfg?: TestRunConfig): TestRunner {
  return new MockTestRunnerImpl(cfg)
}

/** Deps for the real runner. */
export interface RealTestRunnerDeps {
  sandbox: import('../exec/Sandbox.js').Sandbox
  spec?: import('@akis/shared').SpecArtifact
  previewUrl?: string
  timeoutMs?: number
}

/**
 * The REAL test runner (opt-in; only Trace holds it). It delegates the actual
 * cucumber+playwright execution to `runRealTests` (separate module, returns plain
 * stats), then — IN THE TRUSTED PARENT — computes the digest over the exact files
 * and brands the result. The brand stays private to this module, so the heavy
 * runner module can NEVER forge a TestRunResult; it can only report stats.
 * Fail-closed semantics live in runRealTests (timeout / missing report / 0 tests
 * → passed false), and we zero the count unless it genuinely passed, so a non-pass
 * can never mint a VerifyToken.
 */
export function createRealTestRunner(deps: RealTestRunnerDeps): TestRunner {
  return {
    async run(files: RepoFile[], opts?: RunOptions): Promise<TestRunResult> {
      const { runRealTests } = await import('./realRun.js')
      const r = await runRealTests(files, deps)
      // ADDITIVE: report the structured evidence from the rich stats. `passed` here is
      // the run's REAL outcome (r.passed) for display — NOT the zeroed mint value below.
      // This side-channel cannot influence the branded result.
      const evidence = buildTestEvidence({
        passed: r.passed,
        bdd: r.bdd,
        e2e: r.e2e,
        bddScenarios: r.bddScenarios,
        e2eScenarios: r.e2eScenarios,
      })
      opts?.onEvidence?.(evidence)
      const testsRun = r.passed ? r.testsRun : 0
      // evidenceDigest is DERIVED from the SAME evidence reported above — additive
      // tamper-evidence; it never feeds the fail-closed pass decision (r.passed/testsRun).
      return brandResult(testsRun, r.passed, digestFiles(files), digestEvidence(evidence))
    },
  }
}

/** Deps for the boot-smoke runner — the injected boot/probe seam (see verify/bootSmoke.ts).
 *  `boot` is supplied by the trusted wiring (PR2: the PreviewRegistry adapter), so the runner
 *  itself never spawns a process; it only decides pass/fail from probe outcomes. */
export interface BootSmokeRunnerDeps {
  boot: import('./bootSmoke.js').BootSmokeDeps['boot']
  spec?: import('@akis/shared').SpecArtifact
  fetchImpl?: import('./bootSmoke.js').BootSmokeDeps['fetchImpl']
  timeoutMs?: number
  sessionId: string
}

/**
 * The BOOT-SMOKE test runner — verifies a generated app by BOOTING it and probing the running
 * server over HTTP (an always-on `GET /` smoke probe + one probe per derivable acceptance
 * criterion). It delegates the boot+probe flow to {@link import('./bootSmoke.js').runBootSmoke}
 * (which returns plain {@link RealRunResult} stats), then — IN THIS TRUSTED PARENT — computes the
 * digest over the exact files and brands the result through the EXISTING `brandResult` path. The
 * brand stays module-private, so neither the bootSmoke module nor the injected `boot` can forge a
 * TestRunResult; they can only report stats/URLs.
 *
 * Fail-closed semantics live in runBootSmoke (unsupported / boot failure / timeout / failing probe
 * → passed:false), and — exactly as createRealTestRunner does — we ZERO the count unless it
 * genuinely passed, so a non-pass can NEVER mint a VerifyToken (verifier.ts/mint). The always-on
 * smoke probe is the testsRun ≥ 1 floor, so a genuine pass means the app really booted and served.
 */
export function createBootSmokeRunner(deps: BootSmokeRunnerDeps): TestRunner {
  return {
    async run(files: RepoFile[], opts?: RunOptions): Promise<TestRunResult> {
      const { runBootSmoke } = await import('./bootSmoke.js')
      const r = await runBootSmoke(files, {
        boot: deps.boot,
        sessionId: deps.sessionId,
        ...(deps.spec ? { spec: deps.spec } : {}),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      })
      // ADDITIVE observability — same path as the real runner. `passed` is the run's REAL
      // outcome for display; it cannot influence the branded result below.
      const evidence = buildTestEvidence({
        passed: r.passed,
        bdd: r.bdd,
        e2e: r.e2e,
        bddScenarios: r.bddScenarios,
        e2eScenarios: r.e2eScenarios,
      })
      opts?.onEvidence?.(evidence)
      const testsRun = r.passed ? r.testsRun : 0
      // evidenceDigest DERIVED from the SAME evidence — additive tamper-evidence; never feeds
      // the fail-closed pass decision (r.passed/testsRun). Brand via the module-private path.
      return brandResult(testsRun, r.passed, digestFiles(files), digestEvidence(evidence))
    },
  }
}
