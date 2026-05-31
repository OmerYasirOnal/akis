/**
 * Monotonic event clock.
 *
 * Deterministic for tests (a simple counter), so event ordering is stable and
 * reproducible. The runtime can swap a real wall-clock timestamper later; tests
 * rely only on monotonicity, not on real time.
 */
let counter = 0
export function nextTs(): number {
  return ++counter
}
