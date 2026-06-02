import type { RepoFile } from '../di/MockGitHubAdapter.js'
import { digestFiles } from './digest.js'

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
 * cannot substitute a different digest.
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
}

function brandResult(testsRun: number, passed: boolean, codeDigest: string): TestRunResult {
  return { testsRun, passed, codeDigest } as unknown as TestRunResult
}

export interface TestRunner {
  run(files: RepoFile[]): Promise<TestRunResult>
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
  async run(files: RepoFile[]): Promise<TestRunResult> {
    return brandResult(this.cfg.testsRun, this.cfg.passed, digestFiles(files))
  }
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
    async run(files: RepoFile[]): Promise<TestRunResult> {
      const { runRealTests } = await import('./realRun.js')
      const r = await runRealTests(files, deps)
      const testsRun = r.passed ? r.testsRun : 0
      return brandResult(testsRun, r.passed, digestFiles(files))
    },
  }
}
