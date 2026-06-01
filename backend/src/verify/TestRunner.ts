import type { RepoFile } from '../di/MockGitHubAdapter.js'

/**
 * Evidence of a real test execution. BRANDED so that only a TestRunner can
 * produce one — a producer module cannot fabricate `{ testsRun: 1, passed: true }`
 * and have it type-check where a TestRunResult is required. This is the same
 * compile-time guarantee the push gate uses, applied to verification.
 */
export type TestRunResult = {
  readonly __brand: 'TestRunResult'
  readonly testsRun: number
  readonly passed: boolean
}

/**
 * The independent test runner — the ONLY capability that can produce a
 * TestRunResult. Gate 2 + Gate 3 rest on this: only the verifier (Trace) is
 * given a TestRunner, so only Trace can produce verification evidence, and a
 * VerifyToken can only be minted from a TestRunResult that reports a real pass.
 * Producers (Scribe/Proto) hold no runner and cannot manufacture verification.
 */
export interface TestRunner {
  run(files: RepoFile[]): Promise<TestRunResult>
}

export interface TestRunConfig {
  testsRun: number
  passed: boolean
}

/**
 * Deterministic test runner for the mock sub-project. Configured EXPLICITLY
 * (not read off the provider) so scenarios are deterministic without a
 * provider-casting leak.
 *
 * FAIL-CLOSED: the default (no config) is zero tests / not passed, so a real
 * provider with no real runner injected can NEVER auto-verify. Real test
 * execution arrives later behind this same interface.
 */
export class MockTestRunner implements TestRunner {
  constructor(private readonly cfg: TestRunConfig = { testsRun: 0, passed: false }) {}
  async run(_files: RepoFile[]): Promise<TestRunResult> {
    return { __brand: 'TestRunResult', testsRun: this.cfg.testsRun, passed: this.cfg.passed }
  }
}
