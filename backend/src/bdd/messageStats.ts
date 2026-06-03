export interface BddStats {
  built: number       // compiled scenarios (pickles)
  run: number         // test cases started
  passed: number
  failed: number
  skipped: number
  durationMs: number  // summed step durations (run time on this host, not a benchmark)
}

/** ADDITIVE per-scenario BDD detail: scenario name, pass/fail, and on failure the
 *  bad step status + step text. STRUCTURED ONLY (names + bounded labels), so it can
 *  never become trusted RAG grounding. Used to build the persisted TestEvidence. */
export interface BddScenario {
  name: string
  passed: boolean
  /** Bad step status (e.g. 'FAILED'/'UNDEFINED') when the scenario failed. */
  failedStatus?: string
  /** Failing step text when the source identifies one. */
  failedStep?: string
}

type Status = 'PASSED' | 'FAILED' | 'SKIPPED' | 'UNDEFINED' | 'AMBIGUOUS' | 'PENDING' | 'UNKNOWN'
const BAD: Status[] = ['FAILED', 'UNDEFINED', 'AMBIGUOUS', 'PENDING', 'UNKNOWN']

interface Env {
  pickle?: { id?: string; name?: string }
  testCase?: { id?: string; pickleId?: string }
  testCaseStarted?: { id?: string; testCaseId?: string }
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

/**
 * ADDITIVE per-scenario extraction (does NOT touch the minting-critical scalar
 * parse above). Resolves each run test-case back to its pickle name via the
 * cucumber id chain (pickle → testCase.pickleId → testCaseStarted.testCaseId) and
 * marks a scenario failed if any of its steps reported a bad status, recording that
 * status as the structured reason. Robust to partial/garbage streams (unknown names
 * fall back to a stable placeholder). Used only to build the persisted TestEvidence;
 * it never influences the pass/fail counts the gate reads.
 */
export function parseCucumberScenarios(ndjson: string): BddScenario[] {
  const pickleName = new Map<string, string>()        // pickleId → name
  const tcPickle = new Map<string, string>()          // testCaseId → pickleId
  const startedTc = new Map<string, string>()         // testCaseStartedId → testCaseId
  const stepStatuses = new Map<string, Status[]>()     // testCaseStartedId → statuses
  const order: string[] = []                           // testCaseStartedIds in finish order

  for (const line of ndjson.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let env: Env
    try { env = JSON.parse(t) as Env } catch { continue }

    if (env.pickle?.id) pickleName.set(env.pickle.id, env.pickle.name ?? env.pickle.id)
    if (env.testCase?.id) tcPickle.set(env.testCase.id, env.testCase.pickleId ?? '')
    if (env.testCaseStarted?.id) startedTc.set(env.testCaseStarted.id, env.testCaseStarted.testCaseId ?? '')
    if (env.testStepFinished) {
      const id = env.testStepFinished.testCaseStartedId ?? ''
      const status = (env.testStepFinished.testStepResult?.status?.toUpperCase() as Status) ?? 'UNKNOWN'
      const arr = stepStatuses.get(id) ?? []
      arr.push(status)
      stepStatuses.set(id, arr)
    }
    if (env.testCaseFinished?.testCaseStartedId) order.push(env.testCaseFinished.testCaseStartedId)
  }

  return order.map(startedId => {
    const tcId = startedTc.get(startedId) ?? ''
    const pickleId = tcPickle.get(tcId) ?? ''
    // `||` (not `??`) so an empty pickleId/name falls through to the stable startedId placeholder
    // rather than surfacing an empty scenario name when the cucumber id chain is broken.
    const name = pickleName.get(pickleId) || pickleId || startedId
    const statuses = stepStatuses.get(startedId) ?? []
    const bad = statuses.find(s => BAD.includes(s))
    const passed = bad === undefined && statuses.length > 0 && !statuses.every(s => s === 'SKIPPED')
    return passed
      ? { name, passed: true }
      : { name, passed: false, ...(bad ? { failedStatus: bad, failedStep: `step reported ${bad}` } : {}) }
  })
}
