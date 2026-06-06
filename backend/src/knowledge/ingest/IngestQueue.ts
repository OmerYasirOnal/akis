export interface IngestMetrics {
  ingested: number
  failed: number
  deadLettered: number
  dedupHits: number
  excluded: number
  queueDepth: number
}

export interface DeadLetter { task: unknown; error: string }

/** The dead-letter ring cap — newest kept, oldest dropped (see deadLetters). */
export const DEAD_LETTERS_MAX = 100

export interface IngestQueueOpts {
  maxRetries?: number               // default 3 (F1-AC7)
  backoffMs?: (attempt: number) => number  // default 1s/4s/16s; tests pass () => 0
}

/**
 * Async, off-the-agent-path ingestion queue (F1-AC7). Each task is retried up to
 * `maxRetries` with backoff; on budget exhaustion it goes to the dead-letter list
 * (observable, NEVER silently dropped). A worker drains tasks one at a time; the
 * agent run never waits on it. `drain()` lets tests await completion deterministically.
 */
export class IngestQueue {
  private queue: Array<() => Promise<void>> = []
  private running = false
  private maxRetries: number
  private backoffMs: (attempt: number) => number
  /** RING-CAPPED (audit quick-win): each dead letter retains the FULL failed payload (chunk text
   *  included), so an unbounded list slowly eats a long-running server during a flaky embedding
   *  outage. Only the last DEAD_LETTERS_MAX are kept — metrics.deadLettered still carries the
   *  LIFETIME count, so trimming loses no aggregate observability. */
  readonly deadLetters: DeadLetter[] = []
  readonly metrics: IngestMetrics = { ingested: 0, failed: 0, deadLettered: 0, dedupHits: 0, excluded: 0, queueDepth: 0 }

  constructor(opts: IngestQueueOpts = {}) {
    this.maxRetries = opts.maxRetries ?? 3
    this.backoffMs = opts.backoffMs ?? (attempt => 1000 * 4 ** attempt)
  }

  /** Enqueue a unit of work + its describe-for-deadletter payload. Returns immediately. */
  enqueue(task: unknown, run: () => Promise<void>): void {
    this.queue.push(() => this.attempt(task, run, 0))
    this.metrics.queueDepth = this.queue.length
    // Fire-and-forget worker. attempt() already catches per-task failures (retry →
    // dead-letter), so pump() has no throwing path; .catch is a belt-and-suspenders
    // guard against an unexpected rejection becoming an unhandled rejection.
    void this.pump().catch(() => { /* never throws in practice */ })
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!
        this.metrics.queueDepth = this.queue.length
        await job()
      }
    } finally {
      this.running = false
    }
  }

  private async attempt(task: unknown, run: () => Promise<void>, n: number): Promise<void> {
    try {
      await run()
      this.metrics.ingested++
    } catch (err) {
      this.metrics.failed++
      if (n < this.maxRetries) {
        const wait = this.backoffMs(n)
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        await this.attempt(task, run, n + 1)
      } else {
        this.deadLetters.push({ task, error: err instanceof Error ? err.message : String(err) })
        if (this.deadLetters.length > DEAD_LETTERS_MAX) this.deadLetters.splice(0, this.deadLetters.length - DEAD_LETTERS_MAX)
        this.metrics.deadLettered++
      }
    }
  }

  /** Await the queue going idle (worker drained). For deterministic tests. */
  async drain(): Promise<void> {
    while (this.running || this.queue.length > 0) {
      await new Promise(r => setTimeout(r, 0))
    }
  }
}
