export interface Lane<T> { laneId: string; run: () => Promise<T> }
export interface LaneResult<T> { laneId: string; result: T | null; error?: string }

/**
 * Run lanes concurrently and join their results. A lane that throws is isolated
 * to `{ result: null, error }` — one failing branch never rejects the whole
 * fan-out. Used by the orchestrator to dispatch sub-agents in parallel.
 */
export async function runParallel<T>(lanes: Lane<T>[]): Promise<LaneResult<T>[]> {
  return Promise.all(
    lanes.map(async l => {
      try {
        return { laneId: l.laneId, result: await l.run() }
      } catch (e) {
        return { laneId: l.laneId, result: null, error: e instanceof Error ? e.message : String(e) }
      }
    }),
  )
}
