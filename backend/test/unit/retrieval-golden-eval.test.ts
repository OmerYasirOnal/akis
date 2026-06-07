import { describe, it, expect, beforeAll } from 'vitest'
import { buildRag } from '../../src/knowledge/buildRag.js'
import { EventBus } from '../../src/events/bus.js'
import type { RagStack } from '../../src/knowledge/buildRag.js'
import { GOLDEN_CORPUS, GOLDEN_PAIRS } from '../fixtures/golden-corpus.js'

/**
 * Golden-eval retrieval quality gate — the M1 exit criterion F1-AC8 (docs/roadmap.md).
 *
 * WHAT THIS GATE GUARDS (stated honestly): end-to-end retrieval HIT-RATE through the real
 * hybrid path. It ingests a small fixture corpus through the REAL pipeline (vector + BM25
 * fused by RRF, then the second-stage reranker) using the OFFLINE, deterministic
 * LocalEmbeddingProvider — no network, no key, fully reproducible in the normal vitest suite
 * (NODE_ENV=test pins buildRag to Local). It then runs natural-language query→expected-chunk
 * pairs and measures the top-5 hit-rate (a query "hits" when its expected chunk appears in
 * the top-5 results). A drop in top-5 hit-rate — from a regression ANYWHERE on that path
 * (embedding, vector search, BM25, RRF, or rerank) — trips the gate.
 *
 * WHAT THIS GATE DOES NOT GUARD (corrected after review): it is NOT a fusion-specific
 * discriminator. The reviewer proved that vector-only (BM25 stubbed) and full hybrid both
 * score the same on this corpus, so the gate would NOT specifically catch a fusion/ranking
 * regression that leaves single-modality recall intact. The reason is structural: the offline
 * LocalEmbeddingProvider is a signed feature-HASH (largely lexical, no learned semantics), so
 * its vector half is CORRELATED with the BM25 half rather than complementary. We probed for
 * "fusion-teeth" pairs (a target that only reaches top-5 when BOTH halves fuse) and could NOT
 * construct a stable one offline: in every case where one half missed top-5, the OTHER half
 * already ranked the target at top-1..3 alone, so fusion never DID the discriminating work.
 * Per the honesty rule we did NOT fabricate such a pair. A genuinely fusion-specific guard
 * would require the semantic API embedder (text-embedding-3-small), which is out of scope for
 * an offline, no-key, deterministic gate.
 *
 * GATE THRESHOLD: the F1-AC8 target is top-5 ≥80%. The offline embedder CLEARS it — measured
 * 26/26 = 100% top-5 over this corpus through the full hybrid+rerank path (including 4
 * low-overlap synonym/paraphrase pairs; see golden-corpus.ts). We gate at 0.85: above the
 * F1-AC8 floor (0.80) and below the measured rate, so the gate is meaningful (a real
 * end-to-end recall regression trips it) without being brittle to a single borderline pair.
 * Bump the threshold UP (never down) if the corpus/embedder improves; if a future change
 * drops it below 0.80, report the real number and treat it as a regression, not a reason to
 * weaken the gate.
 */

// Measured top-5 hit-rate of the offline LocalEmbeddingProvider over this corpus is 1.00
// (26/26). We gate at 0.85 — above the F1-AC8 floor (0.80), below the measured rate — so the
// gate is meaningful (a real end-to-end recall regression trips it) without being flaky.
const HIT_RATE_GATE = 0.85
const TOP_K = 5

describe('Golden-eval retrieval quality gate (F1-AC8, offline LocalEmbeddingProvider)', () => {
  let stack: RagStack

  beforeAll(async () => {
    // No `embedding` override → under NODE_ENV=test buildRag pins the offline
    // LocalEmbeddingProvider (deterministic, no network). Reranker default on (real path).
    stack = buildRag({ bus: new EventBus(), queue: { backoffMs: () => 0 }, now: () => '2026-06-01T00:00:00Z' })
    for (const doc of GOLDEN_CORPUS) {
      stack.service.ingest({ text: doc.text, source: 'conversation', sourceId: doc.id, userId: 'eval', sessionId: 'eval' })
    }
    await stack.queue.drain()
  })

  it('has a non-trivial golden set (≥20 pairs) over the fixture corpus', () => {
    expect(GOLDEN_PAIRS.length).toBeGreaterThanOrEqual(20)
    expect(stack.service.getMetrics().corpusSize).toBe(GOLDEN_CORPUS.length)
    // Every expected id must exist in the corpus (no typo'd golden labels).
    const ids = new Set(GOLDEN_CORPUS.map(d => d.id))
    for (const p of GOLDEN_PAIRS) expect(ids.has(p.expectedId)).toBe(true)
  })

  it(`achieves end-to-end top-${TOP_K} hit-rate ≥ ${HIT_RATE_GATE * 100}% through the real retrieval path (vector+BM25+RRF+rerank)`, async () => {
    let hits = 0
    const misses: string[] = []
    for (const { query, expectedId } of GOLDEN_PAIRS) {
      const results = await stack.service.retrieve(query, { userId: 'eval' }, TOP_K)
      const hit = results.some(r => r.provenance?.sourceId === expectedId)
      if (hit) hits++
      else misses.push(`${expectedId} ← "${query}"`)
    }
    const hitRate = hits / GOLDEN_PAIRS.length
    // Surface the real number on failure so a regression is debuggable at a glance.
    if (hitRate < HIT_RATE_GATE) {
      // eslint-disable-next-line no-console
      console.error(`top-${TOP_K} hit-rate ${(hitRate * 100).toFixed(1)}% (${hits}/${GOLDEN_PAIRS.length}); misses:\n  ${misses.join('\n  ')}`)
    }
    expect(hitRate).toBeGreaterThanOrEqual(HIT_RATE_GATE)
  })
})
