export interface BddStats {
  built: number       // compiled scenarios (pickles)
  run: number         // test cases started
  passed: number
  failed: number
  skipped: number
  durationMs: number  // summed step durations (run time on this host, not a benchmark)
}

type Status = 'PASSED' | 'FAILED' | 'SKIPPED' | 'UNDEFINED' | 'AMBIGUOUS' | 'PENDING' | 'UNKNOWN'
const BAD: Status[] = ['FAILED', 'UNDEFINED', 'AMBIGUOUS', 'PENDING', 'UNKNOWN']

interface Env {
  pickle?: unknown
  testCaseStarted?: { id?: string }
  testStepFinished?: { testCaseStartedId?: string; testStepResult?: { status?: string; duration?: { seconds?: number; nanos?: number } } }
  testCaseFinished?: { testCaseStartedId?: string }
}

/**
 * Parse cucumber-js message NDJSON (one JSON envelope per line) into BDD stats.
 * A scenario passes iff none of its steps reported a bad status. Robust to partial
 * streams (we may parse the same NDJSON while a run is in progress for live stats).
 */
export function parseCucumberMessages(ndjson: string): BddStats {
  const stepStatuses = new Map<string, Status[]>()
  const stats: BddStats = { built: 0, run: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 }

  for (const line of ndjson.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let env: Env
    try { env = JSON.parse(t) as Env } catch { continue }

    if (env.pickle !== undefined) stats.built++
    if (env.testCaseStarted) stats.run++
    if (env.testStepFinished) {
      const id = env.testStepFinished.testCaseStartedId ?? ''
      const res = env.testStepFinished.testStepResult
      const status = (res?.status?.toUpperCase() as Status) ?? 'UNKNOWN'
      const arr = stepStatuses.get(id) ?? []
      arr.push(status)
      stepStatuses.set(id, arr)
      const d = res?.duration
      if (d) stats.durationMs += (d.seconds ?? 0) * 1000 + (d.nanos ?? 0) / 1e6
    }
    if (env.testCaseFinished) {
      const id = env.testCaseFinished.testCaseStartedId ?? ''
      const statuses = stepStatuses.get(id) ?? []
      if (statuses.some(s => BAD.includes(s))) stats.failed++
      else if (statuses.length > 0 && statuses.every(s => s === 'SKIPPED')) stats.skipped++
      else stats.passed++
    }
  }
  stats.durationMs = Math.round(stats.durationMs)
  return stats
}
