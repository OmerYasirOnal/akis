import { describe, it, expect } from 'vitest'
import { validateWorkflowConfig } from '../../src/workflow/validate.js'
import { WorkflowStore } from '../../src/workflow/WorkflowStore.js'
import { workflowToAgentModels } from '../../src/workflow/resolve.js'
import type { WorkflowConfig, WorkflowConfigInput } from '@akis/shared'

const base = (over: Partial<WorkflowConfigInput> = {}): WorkflowConfigInput => ({
  name: 'default', agents: [{ role: 'scribe' }, { role: 'proto' }, { role: 'trace' }], ...over,
})

describe('validateWorkflowConfig (F2-AC4/AC5)', () => {
  it('accepts a valid preset with per-agent models from the catalog', () => {
    const r = validateWorkflowConfig(base({ agents: [
      { role: 'scribe', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' } },
      { role: 'proto', model: { providerId: 'openai', modelId: 'gpt-4.1-mini' } },
    ] }))
    expect(r.ok).toBe(true)
  })

  it('rejects an unknown provider or model (catalog check, F2-AC6)', () => {
    expect(validateWorkflowConfig(base({ agents: [{ role: 'scribe', model: { providerId: 'acme' } }] })).ok).toBe(false)
    const r = validateWorkflowConfig(base({ agents: [{ role: 'scribe', model: { providerId: 'anthropic', modelId: 'gpt-9' } }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/not in provider/)
  })

  it('rejects granting a gate capability to a producer (producer≠verifier, F2-AC3/AC5)', () => {
    const r = validateWorkflowConfig(base({ agents: [{ role: 'proto', tools: ['run_tests'] }] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.join(' ')).toMatch(/gate capability 'run_tests'/)
  })

  it('rejects push_to_github on a non-orchestrator', () => {
    expect(validateWorkflowConfig(base({ agents: [{ role: 'scribe', tools: ['push_to_github'] }] })).ok).toBe(false)
  })

  it('allows the structural owner to hold its gate tool', () => {
    expect(validateWorkflowConfig(base({ agents: [{ role: 'trace', tools: ['run_tests'] }] })).ok).toBe(true)
    expect(validateWorkflowConfig(base({ agents: [{ role: 'orchestrator', tools: ['push_to_github'] }] })).ok).toBe(true)
  })

  it('rejects a custom agent declared as the verifier (F2-AC3)', () => {
    expect(validateWorkflowConfig(base({ agents: [{ role: 'trace-clone', tools: [] }, { role: 'trace' }] })).ok).toBe(true) // a differently-named custom agent is fine
    expect(validateWorkflowConfig(base({ agents: [{ role: 'custom', tools: ['run_tests'] }] })).ok).toBe(false) // but it can't hold run_tests
  })

  it('rejects an iterate budget above the cap (tighten-only, F2-AC5)', () => {
    expect(validateWorkflowConfig(base({ iterateBudget: 99 })).ok).toBe(false)
    expect(validateWorkflowConfig(base({ iterateBudget: 2 })).ok).toBe(true)
  })

  it('requires a name and at least one agent', () => {
    expect(validateWorkflowConfig(base({ name: '' })).ok).toBe(false)
    expect(validateWorkflowConfig(base({ agents: [] })).ok).toBe(false)
  })

  it('accepts an optional rerank quality knob (issue #7 AC3) — a sibling of rag, not a gate', () => {
    // rerank is a pass-through quality knob like rag: any boolean is valid, it can never
    // loosen a gate, and a missing value is also valid (the stack default applies).
    expect(validateWorkflowConfig(base({ rerank: true })).ok).toBe(true)
    expect(validateWorkflowConfig(base({ rerank: false })).ok).toBe(true)
    expect(validateWorkflowConfig(base()).ok).toBe(true)
  })
})

describe('WorkflowConfig.rerank persists round-trip through the store (issue #7 AC3)', () => {
  it('a saved workflow keeps its rerank toggle', () => {
    const store = new WorkflowStore()
    const wf: WorkflowConfig = store.save({ name: 'rr-off', agents: [{ role: 'scribe' }], rag: true, rerank: false })
    expect(wf.rerank).toBe(false)
    expect(store.get(wf.id)!.rerank).toBe(false)
    const on = store.save({ name: 'rr-on', agents: [{ role: 'proto' }], rerank: true })
    expect(store.get(on.id)!.rerank).toBe(true)
  })
})

describe('WorkflowStore (F2-AC10 versioning)', () => {
  it('assigns version 1 on create and bumps on edit (never mutating the old version)', () => {
    const store = new WorkflowStore()
    const v1 = store.save({ name: 'wf', agents: [{ role: 'scribe' }] })
    expect(v1.version).toBe(1)
    const v2 = store.save({ id: v1.id, name: 'wf', agents: [{ role: 'scribe' }, { role: 'proto' }] })
    expect(v2.version).toBe(2)
    expect(v2.id).toBe(v1.id)
    // The old version is still retrievable unchanged (in-flight runs keep their version).
    expect(store.get(v1.id, 1)!.agents).toHaveLength(1)
    expect(store.get(v1.id)!.version).toBe(2) // latest
  })
  it('lists the latest of each workflow', () => {
    const store = new WorkflowStore()
    const a = store.save({ name: 'a', agents: [{ role: 'scribe' }] })
    store.save({ id: a.id, name: 'a', agents: [{ role: 'scribe' }] })
    store.save({ name: 'b', agents: [{ role: 'proto' }] })
    const list = store.list()
    expect(list).toHaveLength(2)
    expect(list.find(w => w.id === a.id)!.version).toBe(2)
  })
})

describe('workflowToAgentModels (F2-AC9 resolution)', () => {
  it('maps core roles with a model; ignores custom roles and model-less agents', () => {
    const wf: WorkflowConfig = { id: 'w', version: 1, name: 'x', agents: [
      { role: 'scribe', model: { providerId: 'anthropic', modelId: 'claude-opus-4-8' } },
      { role: 'proto', model: { providerId: 'openai' } },     // no modelId → provider only
      { role: 'trace' },                                       // no model → skipped
      { role: 'custom', model: { providerId: 'anthropic', modelId: 'x' } }, // non-core → skipped
    ] }
    const m = workflowToAgentModels(wf)
    expect(m.scribe).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8' })
    expect(m.proto).toEqual({ provider: 'openai' })
    expect(m.trace).toBeUndefined()
    expect('custom' in m).toBe(false)
  })
})
