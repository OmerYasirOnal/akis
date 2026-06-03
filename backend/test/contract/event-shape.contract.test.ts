/**
 * CONTRACT: the AkisEvent union shape is FROZEN at the type level.
 *
 * The event union is the wire contract between backend and frontend. This test
 * pins it so a change is a deliberate, reviewed act:
 *   - the `gate` event stays TIGHTEN-ONLY: exactly 'spec_approval' | 'push_confirm'
 *     (adding a human gate kind here would loosen the structural-gate contract).
 *   - the `verify` event stays the gate's source of truth (testsRun + passed).
 *   - the `code_review` event is the READ-ONLY critic verdict surfaced to the UI:
 *     STRUCTURED ONLY (booleans + bounded counts), never free-form LLM prose, so
 *     it can never become trusted RAG grounding (see IngestionSink).
 */
import { describe, it, expect, expectTypeOf } from 'vitest'
import type { AkisEvent } from '@akis/shared'

type KindOf<K extends AkisEvent['kind']> = Extract<AkisEvent, { kind: K }>

describe('CONTRACT: AkisEvent union shape (frozen)', () => {
  it('the gate event is tighten-only — exactly 2 kinds', () => {
    // FAILS TO COMPILE if a third gate kind is ever added (loosening the contract).
    expectTypeOf<KindOf<'gate'>['gate']>().toEqualTypeOf<'spec_approval' | 'push_confirm'>()
  })

  it('the verify event stays the gate truth (testsRun + passed)', () => {
    expectTypeOf<KindOf<'verify'>>().toMatchTypeOf<{ testsRun: number; passed: boolean }>()
  })

  it('P1-CORE-1: verify + preview_status carry an ADDITIVE optional `demo` annotation', () => {
    // The freeze stays intact: `demo` is OPTIONAL (informational only), so the structural
    // gate-truth shape above is unchanged and a live event with no `demo` field still
    // satisfies the type. These guards trip if `demo` is ever made required (a freeze break)
    // or made a non-boolean (e.g. leaking the VerifyToken/secret onto the wire).
    expectTypeOf<KindOf<'verify'>['demo']>().toEqualTypeOf<boolean | undefined>()
    expectTypeOf<KindOf<'preview_status'>['demo']>().toEqualTypeOf<boolean | undefined>()
    // A verify event WITHOUT demo is still valid (additive ⇒ backward compatible).
    const live: KindOf<'verify'> = { kind: 'verify', testsRun: 1, passed: true, agent: 'trace', laneId: 'main', sessionId: 's1', ts: 1 }
    expect(live.demo).toBeUndefined()
    const demo: KindOf<'verify'> = { ...live, demo: true }
    expect(demo.demo).toBe(true)
  })

  it('the code_review event is structured-only (no free-form text field)', () => {
    const e: KindOf<'code_review'> = {
      kind: 'code_review', approved: false, findings: 2, critical: false, iteration: 1,
      agent: 'critic', laneId: 'main', sessionId: 's1', ts: 1,
    }
    expect(e.kind).toBe('code_review')
    expectTypeOf<KindOf<'code_review'>>().toMatchTypeOf<{
      approved: boolean; findings: number; critical: boolean; iteration: number
    }>()
    // @ts-expect-error — code_review carries NO free-form prose (would be an untrusted→trusted vector)
    expectTypeOf<KindOf<'code_review'>>().toMatchTypeOf<{ text: string }>()
  })

  it('the union enumerates the expected kinds (a missing/renamed kind trips this)', () => {
    const kinds: AkisEvent['kind'][] = [
      'session', 'text', 'agent_start', 'agent_end', 'tool_call', 'tool_result',
      'gate', 'verify', 'code_review', 'preview', 'preview_status',
      'test_progress', 'test_stats', 'done', 'error',
    ]
    // A compile-time exhaustiveness guard: assigning each literal back into the union
    // proves these are all valid kinds; dropping a kind from the union breaks the build.
    const set = new Set<AkisEvent['kind']>(kinds)
    expect(set.has('code_review')).toBe(true)
    expect(set.size).toBe(15)
  })
})
