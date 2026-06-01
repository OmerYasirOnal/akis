import { describe, it, expect } from 'vitest'
import { runParallel } from '../../src/orchestrator/parallel.js'

describe('runParallel', () => {
  it('runs lanes concurrently and joins results with their laneId', async () => {
    const out = await runParallel([
      { laneId: 'a', run: async () => 1 },
      { laneId: 'b', run: async () => 2 },
    ])
    expect(out).toEqual([{ laneId: 'a', result: 1 }, { laneId: 'b', result: 2 }])
  })
  it('isolates a failing lane to null, others succeed', async () => {
    const out = await runParallel([
      { laneId: 'a', run: async () => { throw new Error('x') } },
      { laneId: 'b', run: async () => 2 },
    ])
    expect(out[0]).toEqual({ laneId: 'a', result: null, error: 'x' })
    expect(out[1]).toEqual({ laneId: 'b', result: 2 })
  })
})
