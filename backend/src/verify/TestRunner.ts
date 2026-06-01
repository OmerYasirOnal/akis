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
export class MockTestRunner implements TestRunner {
  constructor(private readonly cfg: TestRunConfig = { testsRun: 0, passed: false }) {}
  async run(files: RepoFile[]): Promise<TestRunResult> {
    return brandResult(this.cfg.testsRun, this.cfg.passed, digestFiles(files))
  }
}
