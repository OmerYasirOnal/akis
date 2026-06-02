import { describe, it, expect } from 'vitest'
import { WorkflowStore, type WorkflowStorePort } from '../../src/workflow/WorkflowStore.js'
import type { WorkflowConfig } from '@akis/shared'

/**
 * The in-memory WorkflowStore now satisfies the ASYNC WorkflowStorePort so it is a
 * drop-in for the durable PgWorkflowStore. save/get/list all return Promises; the
 * versioning + latest-per-id semantics are unchanged from the synchronous store.
 */
describe('WorkflowStore implements the async WorkflowStorePort', () => {
  it('is assignable to WorkflowStorePort (structural conformance)', () => {
    const store: WorkflowStorePort = new WorkflowStore()
    expect(store).toBeTruthy()
  })

  it('save resolves a versioned config and get awaits the latest (or a specific) version', async () => {
    const store: WorkflowStorePort = new WorkflowStore()
    const v1 = await store.save({ name: 'wf', agents: [{ role: 'scribe' }] })
    expect(v1.version).toBe(1)
    const v2 = await store.save({ id: v1.id, name: 'wf', agents: [{ role: 'scribe' }, { role: 'proto' }] })
    expect(v2.version).toBe(2)
    expect(v2.id).toBe(v1.id)
    const got1 = await store.get(v1.id, 1)
    expect(got1?.agents).toHaveLength(1)
    const latest = await store.get(v1.id)
    expect(latest?.version).toBe(2)
  })

  it('get of an unknown id resolves undefined', async () => {
    const store: WorkflowStorePort = new WorkflowStore()
    expect(await store.get('nope')).toBeUndefined()
  })

  it('list resolves the latest of every workflow', async () => {
    const store: WorkflowStorePort = new WorkflowStore()
    const a = await store.save({ name: 'a', agents: [{ role: 'scribe' }] })
    await store.save({ id: a.id, name: 'a', agents: [{ role: 'scribe' }] })
    await store.save({ name: 'b', agents: [{ role: 'proto' }] })
    const list: WorkflowConfig[] = await store.list()
    expect(list).toHaveLength(2)
    expect(list.find(w => w.id === a.id)?.version).toBe(2)
  })

  it('round-trips the rerank=false quality knob through save/get', async () => {
    const store: WorkflowStorePort = new WorkflowStore()
    const wf = await store.save({ name: 'rr-off', agents: [{ role: 'scribe' }], rag: true, rerank: false })
    expect(wf.rerank).toBe(false)
    expect((await store.get(wf.id))?.rerank).toBe(false)
  })
})
