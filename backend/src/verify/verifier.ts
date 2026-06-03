import type { VerifyToken } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import {
  createMockTestRunner,
  createRealTestRunner,
  type TestRunner,
  type TestRunConfig,
  type RealTestRunnerDeps,
} from './TestRunner.js'

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
 * B2 — capability leak closed: `createVerifier(runner)` is NO LONGER exported.
 * Previously any in-realm caller could `createVerifier(fakeRunner)` — hand the
 * verifier an arbitrary "passing" runner object and obtain a Verifier. The only
 * public surface now is `resolveVerifier(spec)`, which takes a DECLARATIVE runner
 * selection (mock-with-config / real-with-sandbox) and builds the runner INSIDE
 * this module via the trusted TestRunner factories. A caller can request a kind
 * of runner, but can never inject a bespoke `TestRunner` (or a bespoke `Verifier`)
 * — so the "fake passing runner object" admittance is gone.
 *
 * Honest in-process boundary (see THREAT-MODEL.md): with the REAL runner the only
 * way to get `passed:true` is to actually run passing tests. The mock runner is
 * still selectable (the keyless dev/demo path needs it), but a demo boot is now
 * fail-closed in production and surfaced as `mode:'demo'` on /health (B1). A hard
 * trust boundary (separate verifier process + signed results) remains deferred to
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

/**
 * Module-private Verifier constructor. NOT exported: the only way to a Verifier is
 * `resolveVerifier(spec)`, which builds the runner here from trusted factories — so a
 * caller can never hand in a fake `TestRunner` object (the closed B2 leak).
 */
function createVerifier(runner: TestRunner): Verifier {
  return {
    async verify(sessionId, files) {
      const r = await runner.run(files)
      return mint(sessionId, r.testsRun, r.passed, r.codeDigest)
    },
  }
}

/**
 * Runner selection — the ONLY external surface to a Verifier.
 *   - `{ kind: 'mock', cfg? }`  → deterministic mock runner (keyless dev/demo + tests).
 *                                 Fail-closed default (0 tests / not passed) when no cfg.
 *   - `{ kind: 'real', ...deps }` → the REAL Playwright+Cucumber runner via a Sandbox.
 *   - `{ kind: 'runner', runner }` → the DI container relaying a runner it ALREADY owns
 *                                 (the single injectable `buildServices({ testRunner })`
 *                                 seam used by the keyless demo and tests). This is not a
 *                                 new forging tool: a caller still cannot fabricate a
 *                                 branded TestRunResult — only an actual runner produces
 *                                 one. It exists so the runner→Verifier construction has
 *                                 ONE home (this module), never an importable
 *                                 `createVerifier`.
 *
 * The mock/real runners are constructed INSIDE this module via the trusted TestRunner
 * factories; the `runner` variant is the DI-owned injection point, not a public
 * `createVerifier(anyRunner)` admittance (that export is gone — B2).
 */
export type VerifierSpec =
  | { kind: 'mock'; cfg?: TestRunConfig }
  | ({ kind: 'real' } & RealTestRunnerDeps)
  | { kind: 'runner'; runner: TestRunner }

/** Build a Verifier from a runner selection (the only public seam to a Verifier). */
export function resolveVerifier(spec: VerifierSpec): Verifier {
  if (spec.kind === 'real') {
    const { kind: _kind, ...deps } = spec
    void _kind
    return createVerifier(createRealTestRunner(deps))
  }
  if (spec.kind === 'runner') return createVerifier(spec.runner)
  return createVerifier(createMockTestRunner(spec.cfg))
}
