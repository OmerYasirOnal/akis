export interface E2eStats {
  testsRun: number
  passed: boolean    // ≥1 expected (or flaky) and ZERO unexpected
  expected: number
  unexpected: number
  flaky: number
  skipped: number
  durationMs: number
}

interface PwReport {
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number; duration?: number }
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
