export interface E2eStats {
  testsRun: number
  passed: boolean    // ≥1 expected (or flaky) and ZERO unexpected
  expected: number
  unexpected: number
  flaky: number
  skipped: number
  durationMs: number
}

/** ADDITIVE per-test E2E detail: spec title, pass/fail, structured outcome on failure.
 *  STRUCTURED ONLY (title + bounded outcome label), so it can never become trusted RAG
 *  grounding. Used to build the persisted TestEvidence; never influences the gate. */
export interface E2eScenario {
  name: string
  passed: boolean
  /** Bounded Playwright outcome label when the test failed (e.g. 'unexpected'/'timedOut'). */
  outcome?: string
}

interface PwReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number; duration?: number }
  suites?: PwSuite[]
}

interface PwSuite {
  title?: string
  suites?: PwSuite[]
  specs?: PwSpec[]
}

interface PwSpec {
  title?: string
  ok?: boolean
  tests?: { status?: string; results?: { status?: string }[] }[]
}

/**
 * Parse the Playwright JSON report's top-level `stats` block.
 *   testsRun = expected + unexpected + flaky
 *   passed   = unexpected === 0 && (expected + flaky) >= 1
 * Fail-closed: a missing/garbage report → testsRun 0, passed false (so it can NEVER
 * mint a VerifyToken).
 */
export function parsePlaywrightReport(json: string): E2eStats {
  const empty: E2eStats = { testsRun: 0, passed: false, expected: 0, unexpected: 0, flaky: 0, skipped: 0, durationMs: 0 }
  let report: PwReport
  try { report = JSON.parse(json) as PwReport } catch { return empty }
  const s = report.stats
  if (!s) return empty
  const expected = s.expected ?? 0
  const unexpected = s.unexpected ?? 0
  const flaky = s.flaky ?? 0
  const testsRun = expected + unexpected + flaky
  return {
    testsRun,
    passed: unexpected === 0 && expected + flaky >= 1,
    expected, unexpected, flaky,
    skipped: s.skipped ?? 0,
    durationMs: Math.round(s.duration ?? 0),
  }
}

/**
 * ADDITIVE per-spec extraction (does NOT touch the minting-critical scalar parse
 * above). Walks the Playwright report's nested suites/specs tree, recording each
 * spec's title and pass/fail with a bounded outcome label on failure. A spec passes
 * iff `spec.ok` is true (Playwright's own per-spec verdict). Robust to a
 * missing/garbage report → []. Used only to build the persisted TestEvidence.
 */
export function parsePlaywrightScenarios(json: string): E2eScenario[] {
  let report: PwReport
  try { report = JSON.parse(json) as PwReport } catch { return [] }
  const out: E2eScenario[] = []
  const walk = (suites: PwSuite[] | undefined): void => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        const passed = spec.ok === true
        const name = spec.title ?? '(unnamed spec)'
        if (passed) out.push({ name, passed: true })
        else {
          const status = spec.tests?.flatMap(t => t.results ?? []).find(r => r.status && r.status !== 'passed')?.status
          out.push({ name, passed: false, ...(status ? { outcome: status } : { outcome: 'failed' }) })
        }
      }
      walk(suite.suites)
    }
  }
  walk(report.suites)
  return out
}
