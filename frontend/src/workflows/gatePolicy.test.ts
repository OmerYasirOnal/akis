import { describe, it, expect } from 'vitest'
import { GATE_TOOL_OWNER, MAX_ITERATE_BUDGET } from '@akis/shared'
import {
  isGateAllowedForRole,
  clampIterateBudget,
  validateWorkflowDraft,
  STRUCTURAL_GATES,
  applyGatePolicy,
  type DraftCatalogProvider,
} from './gatePolicy.js'

/** A fake provider catalog (the GET /api/providers shape) the pure guards validate against. */
const CATALOG: DraftCatalogProvider[] = [
  { id: 'anthropic', models: [{ id: 'claude-haiku-4-5-20251001' }, { id: 'claude-opus-4-8' }] },
  { id: 'openai', models: [{ id: 'gpt-4.1-mini' }] },
]

describe('isGateAllowedForRole', () => {
  it('is false for a gate tool on a non-owner role', () => {
    // run_tests is owned by trace → never allowed for proto/scribe/orchestrator/critic.
    expect(isGateAllowedForRole('proto', 'run_tests')).toBe(false)
    expect(isGateAllowedForRole('orchestrator', 'run_tests')).toBe(false)
    expect(isGateAllowedForRole('scribe', 'push_to_github')).toBe(false)
    expect(isGateAllowedForRole('critic', 'dispatch_trace')).toBe(false)
  })

  it('is true ONLY for the GATE_TOOL_OWNER of a gate tool', () => {
    for (const [tool, owner] of Object.entries(GATE_TOOL_OWNER)) {
      expect(isGateAllowedForRole(owner, tool)).toBe(true)
      // every non-owner core role is rejected
      for (const role of ['orchestrator', 'scribe', 'proto', 'trace', 'critic'] as const) {
        if (role !== owner) expect(isGateAllowedForRole(role, tool)).toBe(false)
      }
    }
  })

  it('allows a non-gate tool for any role', () => {
    expect(isGateAllowedForRole('proto', 'chat')).toBe(true)
    expect(isGateAllowedForRole('scribe', 'ask')).toBe(true)
  })
})

describe('clampIterateBudget', () => {
  it('clamps 5 -> 3, 0 -> 1, 2 -> 2', () => {
    expect(clampIterateBudget(5)).toBe(MAX_ITERATE_BUDGET)
    expect(clampIterateBudget(5)).toBe(3)
    expect(clampIterateBudget(0)).toBe(1)
    expect(clampIterateBudget(2)).toBe(2)
    expect(clampIterateBudget(1)).toBe(1)
    expect(clampIterateBudget(3)).toBe(3)
  })

  it('floors non-integers into range', () => {
    expect(clampIterateBudget(2.9)).toBe(2)
    expect(clampIterateBudget(-4)).toBe(1)
    expect(clampIterateBudget(Number.NaN)).toBe(1)
  })
})

describe('validateWorkflowDraft', () => {
  const base = { name: 'wf', agents: [{ role: 'proto' as const }] }

  it('accepts a minimal valid draft', () => {
    expect(validateWorkflowDraft(base, CATALOG)).toEqual({ ok: true })
  })

  it('rejects granting a gate tool to a non-owner role, naming role + tool (mirrors validate.ts)', () => {
    const res = validateWorkflowDraft(
      { name: 'wf', agents: [{ role: 'proto', tools: ['run_tests'] }] },
      CATALOG,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.errors).toContain(`agent 'proto': cannot hold gate capability 'run_tests' (only 'trace' may)`)
  })

  it('allows a gate tool for its structural owner', () => {
    expect(validateWorkflowDraft(
      { name: 'wf', agents: [{ role: 'trace', tools: ['run_tests'] }] },
      CATALOG,
    )).toEqual({ ok: true })
  })

  it('rejects a missing name and an empty agent list', () => {
    expect(validateWorkflowDraft({ name: '  ', agents: [{ role: 'proto' }] }, CATALOG).ok).toBe(false)
    expect(validateWorkflowDraft({ name: 'wf', agents: [] }, CATALOG).ok).toBe(false)
  })

  it('accepts iterateBudget 1, 2, 3 and rejects >3 and <1', () => {
    for (const b of [1, 2, 3]) {
      expect(validateWorkflowDraft({ ...base, iterateBudget: b }, CATALOG)).toEqual({ ok: true })
    }
    const tooHigh = validateWorkflowDraft({ ...base, iterateBudget: 4 }, CATALOG)
    expect(tooHigh.ok).toBe(false)
    if (tooHigh.ok) throw new Error('expected failure')
    expect(tooHigh.errors.some(e => e.includes('tighten-only') && e.includes('3'))).toBe(true)

    const tooLow = validateWorkflowDraft({ ...base, iterateBudget: 0 }, CATALOG)
    expect(tooLow.ok).toBe(false)
    if (tooLow.ok) throw new Error('expected failure')
    expect(tooLow.errors.some(e => e.includes('positive integer'))).toBe(true)
  })

  it('rejects an unknown providerId', () => {
    const res = validateWorkflowDraft(
      { name: 'wf', agents: [{ role: 'proto', model: { providerId: 'nope' } }] },
      CATALOG,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.errors).toContain(`agent 'proto': unknown providerId 'nope'`)
  })

  it('rejects a modelId not in the provider catalog', () => {
    const res = validateWorkflowDraft(
      { name: 'wf', agents: [{ role: 'proto', model: { providerId: 'anthropic', modelId: 'ghost-model' } }] },
      CATALOG,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('expected failure')
    expect(res.errors).toContain(`agent 'proto': model 'ghost-model' not in provider 'anthropic' catalog`)
  })

  it('accepts a known providerId + modelId pair', () => {
    expect(validateWorkflowDraft(
      { name: 'wf', agents: [{ role: 'proto', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' } }] },
      CATALOG,
    )).toEqual({ ok: true })
  })
})

describe('STRUCTURAL_GATES + applyGatePolicy (tighten-only)', () => {
  it('is exactly the 4 structural gate ids', () => {
    expect([...STRUCTURAL_GATES]).toEqual(['spec_approval', 'real_test_verification', 'push_confirm', 'critic_resolution'])
    expect(STRUCTURAL_GATES).toHaveLength(4)
  })

  it('toggling requireCriticResolution ON never removes a structural gate', () => {
    const off = applyGatePolicy({ requireCriticResolution: false })
    const on = applyGatePolicy({ requireCriticResolution: true })
    for (const g of STRUCTURAL_GATES) {
      expect(off.map(x => x.id)).toContain(g)
      expect(on.map(x => x.id)).toContain(g)
    }
    // all 4 are always enforced; only critic_resolution's enforced-by-default vs required-policy differs
    expect(off.every(x => x.enforced)).toBe(true)
    expect(on.every(x => x.enforced)).toBe(true)
    expect(off).toHaveLength(4)
    expect(on).toHaveLength(4)
  })

  it('a draft can never disable a structural gate (no policy key exists to do so)', () => {
    // The only gate-policy lever is requireCriticResolution; there is no API to drop a gate.
    const gates = applyGatePolicy(undefined)
    expect(gates).toHaveLength(4)
    expect(gates.every(x => x.enforced)).toBe(true)
  })
})
