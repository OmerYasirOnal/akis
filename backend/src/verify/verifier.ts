import type { VerifyToken } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import type { TestRunner } from './TestRunner.js'

/**
 * The Verifier capability — the ONLY way to produce a VerifyToken.
 *
 * The mint function is module-private (not exported), so no other module can
 * `import` it: a forging attempt is a COMPILE ERROR (TS2305), not a convention.
 * A VerifyToken is therefore obtainable ONLY by holding a Verifier and running
 * its `verify()`, which runs a TestRunner and fails closed unless the run
 * reported a genuine ≥1-test pass. In the DI container only Trace (the verifier
 * role) is given a Verifier, so only the verifier can verify.
 *
 * Honest in-process boundary (see THREAT-MODEL.md): a first-party module in the
 * same realm could still call `createVerifier(...)` with a fake passing runner.
 * In the mock that is trivial by design; with a REAL TestRunner the only way to
 * get `passed:true` is to actually run passing tests. Closing the fake-runner
 * gap requires moving the verifier across a process/trust boundary, deferred to
 * the sandboxed-execution sub-project.
 */
function mint(sessionId: string, testsRun: number, passed: boolean, codeDigest: string): VerifyToken | null {
  if (testsRun >= 1 && passed === true) {
    return { sessionId, testsRun, codeDigest } as unknown as VerifyToken
  }
  return null
}

export interface Verifier {
  /** Run the tests over the files and, only on a genuine pass, mint a bound VerifyToken. */
  verify(sessionId: string, files: RepoFile[]): Promise<VerifyToken | null>
}

export function createVerifier(runner: TestRunner): Verifier {
  return {
    async verify(sessionId, files) {
      const r = await runner.run(files)
      return mint(sessionId, r.testsRun, r.passed, r.codeDigest)
    },
  }
}
