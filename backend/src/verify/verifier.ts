import type { VerifyToken } from '@akis/shared'
import type { RepoFile } from '../di/MockGitHubAdapter.js'
import {
  createMockTestRunner,
  createRealTestRunner,
  type TestRunner,
  type TestRunConfig,
  type RealTestRunnerDeps,
  type RunOptions,
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
  /**
   * Run the tests over the files and, only on a genuine pass, mint a bound VerifyToken.
   *
   * `opts.onEvidence` is an ADDITIVE, NON-GATE observability sink: the underlying runner
   * reports the structured TestEvidence it computed. It is a pure side-channel — it can
   * NEVER influence whether a token is minted (mint reads only `r.testsRun`/`r.passed`),
   * so the return value is byte-identical whether or not it is supplied.
   */
  verify(sessionId: string, files: RepoFile[], opts?: RunOptions): Promise<VerifyToken | null>
  /**
   * Whether this verifier runs the MOCK/injected runner (simulated verification) rather than
   * the REAL Playwright+Cucumber runner. PURELY INFORMATIONAL — Trace stamps the wire `verify`
   * event with `demo:true` so a simulated result can never be mistaken for a real pass AT THE
   * RESULT. It does NOT gate verification or change minting: the only way to a VerifyToken is
   * still a genuine ≥1-test pass (see `mint`). `false` for the real runner ⇒ a live verify
   * event stays byte-identical (no `demo` field on the wire).
   */
  readonly demo: boolean
}

/**
 * Module-private Verifier constructor. NOT exported: the only way to a Verifier is
 * `resolveVerifier(spec)`, which builds the runner here from trusted factories — so a
 * caller can never hand in a fake `TestRunner` object (the closed B2 leak).
 *
 * `demo` is a property of WHICH runner backs the verifier (mock vs real), not of the run's
 * outcome — it is informational metadata only and never touches the fail-closed `mint`.
 */
function createVerifier(runner: TestRunner, demo: boolean): Verifier {
  return {
    demo,
    async verify(sessionId, files, opts) {
      // The evidence sink (opts.onEvidence) is forwarded to the runner UNCHANGED; the
      // mint below reads ONLY the branded result, so evidence can never affect minting.
      const r = await runner.run(files, opts)
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

/** Build a Verifier from a runner selection (the only public seam to a Verifier). The `demo`
 *  flag is derived HERE from the same runner selection the DI makes from #59's demo signal:
 *  ONLY `kind:'real'` is a live verifier; `mock` (fail-closed default) and `runner` (the
 *  injected mock under AKIS_ALLOW_MOCK / AKIS_DEMO_VERIFY) are simulated verification ⇒ demo. */
export function resolveVerifier(spec: VerifierSpec): Verifier {
  if (spec.kind === 'real') {
    const { kind: _kind, ...deps } = spec
    void _kind
    return createVerifier(createRealTestRunner(deps), false)
  }
  if (spec.kind === 'runner') return createVerifier(spec.runner, true)
  return createVerifier(createMockTestRunner(spec.cfg), true)
}
