import type { RepoFile } from '../di/MockGitHubAdapter.js'

/**
 * Evidence of a real test execution.
 *
 * NOMINAL BRAND: the brand key is a `unique symbol` private to THIS module, so a
 * TestRunResult cannot be constructed as a literal anywhere else (not even with
 * `as TestRunResult` — TS2352). Only `brandResult` below applies it, and only
 * the `run()` methods in this module call it. A producer module therefore cannot
 * fabricate test evidence; it can only obtain one by actually invoking a runner.
 */
declare const resultBrand: unique symbol

export type TestRunResult = {
  readonly [resultBrand]: true
  readonly testsRun: number
  readonly passed: boolean
}

function brandResult(testsRun: number, passed: boolean): TestRunResult {
  return { testsRun, passed } as unknown as TestRunResult
}

/**
 * The independent test runner — the ONLY capability that can produce a
 * TestRunResult. Gate 2 + Gate 3 rest on this: only the verifier (Trace) is
 * given a TestRunner in the DI container, so in the wired system only Trace
 * produces verification evidence, and a VerifyToken can only be minted from a
 * TestRunResult that reports a real pass.
 *
 * Honest boundary: in a single process, TypeScript cannot prevent a same-graph
 * module from importing MockTestRunner and calling it. The structural guarantees
 * are: (1) no literal/accidental forgery of a result, (2) the production wiring
 * grants the runner only to Trace (asserted by test), (3) fail-closed minting. A
 * hard boundary (separate verifier process/role) is future work.
 */
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
 * provider with no real runner injected can NEVER auto-verify. Real test
 * execution arrives later behind this same interface.
 */
export class MockTestRunner implements TestRunner {
  constructor(private readonly cfg: TestRunConfig = { testsRun: 0, passed: false }) {}
  async run(_files: RepoFile[]): Promise<TestRunResult> {
    return brandResult(this.cfg.testsRun, this.cfg.passed)
  }
}
