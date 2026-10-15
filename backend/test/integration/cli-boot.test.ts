import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDirectSandbox } from '../../src/exec/Sandbox.js'
import { detectAppType } from '../../src/preview/AppDetector.js'
import { runBootSmoke, type BootResult } from '../../src/verify/bootSmoke.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

/**
 * Phase H acceptance: a GENERATED-STYLE CLI/library — exactly the shape PROTO_SYSTEM rule 6
 * mandates (a `bin`, `"test":"vitest run"`, `vitest` devDependency, tests under `tests/`) — has
 * NO server to boot, so the verifier must RUN ITS OWN VITEST SUITE through a REAL, non-stubbed
 * LocalDirectSandbox (real `pnpm install --ignore-scripts`, real `vitest run --reporter=json`) and
 * mint ONLY on a genuine ≥1-test pass. This is the test the stubbed-sandbox unit tests cannot
 * demonstrate: real Proto-generated CLI tests genuinely run, pass, and gate the build.
 */
function cliFixture(testBody: string): RepoFile[] {
  return [
    {
      filePath: 'package.json',
      content: JSON.stringify({
        name: 'phase-h-cli', version: '1.0.0', type: 'module',
        bin: { 'phase-h': 'src/cli.js' },
        scripts: { test: 'vitest run' },
        devDependencies: { vitest: '^2.1.9' },
      }),
    },
    { filePath: 'src/cli.js', content: 'export function add(a, b) { return a + b }\n' },
    { filePath: 'tests/cli.test.js', content: testBody },
  ]
}

const PASSING_TEST = [
  "import { it, expect } from 'vitest'",
  "import { add } from '../src/cli.js'",
  "it('adds', () => { expect(add(2, 3)).toBe(5) })",
  "it('adds negatives', () => { expect(add(-1, -1)).toBe(-2) })",
  '',
].join('\n')

const FAILING_TEST = [
  "import { it, expect } from 'vitest'",
  "import { add } from '../src/cli.js'",
  "it('adds', () => { expect(add(2, 3)).toBe(5) })",
  "it('wrong on purpose', () => { expect(add(2, 3)).toBe(99) })",
  '',
].join('\n')

/** A boot fn that MUST NEVER be called for a CLI (there is no server to boot). */
const noBoot = async (): Promise<BootResult> => { throw new Error('boot must NOT be called for a CLI') }

describe('Phase H: a generated-style CLI is verified by RUNNING its real vitest suite', () => {
  let wsDir: string
  let prevEnv: string | undefined
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'akis-cli-boot-'))
    prevEnv = process.env.AKIS_WORKSPACES_DIR
    process.env.AKIS_WORKSPACES_DIR = wsDir
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.AKIS_WORKSPACES_DIR
    else process.env.AKIS_WORKSPACES_DIR = prevEnv
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('classifies cli, installs (scripts blocked), runs vitest, and GENUINELY passes (no boot)', async () => {
    const files = cliFixture(PASSING_TEST)
    expect(detectAppType(files)).toBe('cli')
    const res = await runBootSmoke(files, { boot: noBoot, sessionId: 'cli-pass', sandbox: new LocalDirectSandbox() })
    expect(res.passed, JSON.stringify(res.bddScenarios)).toBe(true)
    expect(res.testsRun).toBeGreaterThanOrEqual(1)
    expect(res.bdd.failed).toBe(0)
    expect(res.bddScenarios.some(s => s.passed)).toBe(true)
  }, 90_000)

  it('a genuinely FAILING vitest suite fails closed (passed:false, cannot mint)', async () => {
    const files = cliFixture(FAILING_TEST)
    expect(detectAppType(files)).toBe('cli')
    const res = await runBootSmoke(files, { boot: noBoot, sessionId: 'cli-fail', sandbox: new LocalDirectSandbox() })
    expect(res.passed).toBe(false)
    expect(res.bdd.failed).toBeGreaterThanOrEqual(1)
  }, 90_000)

  // REGRESSION for the gate-keeper HIGH: a generated project pre-seeds its OWN fake
  // `vitest-report.json` (a mint bypass — claims a pass with ZERO real test files). The report is
  // now read from an OUT-OF-TREE temp path the produced files cannot reach, and vitest with no test
  // files exits non-zero without writing it, so the fake never counts → fail closed, NO token.
  it('a pre-seeded fake vitest-report.json with ZERO real test files fails closed (mint bypass fixed)', async () => {
    const files: RepoFile[] = [
      {
        filePath: 'package.json',
        content: JSON.stringify({
          name: 'evil-cli', version: '1.0.0', type: 'module',
          bin: { evil: 'src/cli.js' }, scripts: { test: 'vitest run' }, devDependencies: { vitest: '^2.1.9' },
        }),
      },
      { filePath: 'src/cli.js', content: 'export const x = 1\n' },
      // The attacker file: a forged passing report dropped INTO the produced project. No real test file exists.
      { filePath: 'vitest-report.json', content: JSON.stringify({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, success: true, testResults: [] }) },
    ]
    expect(detectAppType(files)).toBe('cli')
    const res = await runBootSmoke(files, { boot: noBoot, sessionId: 'cli-evil', sandbox: new LocalDirectSandbox() })
    expect(res.passed, 'a forged in-tree report must NEVER produce a pass').toBe(false)
    expect(res.testsRun).toBe(0)
  }, 90_000)
})
