import { describe, it, expect } from 'vitest'
import { ToolRegistry } from '../../src/agent/tools/ToolRegistry.js'

describe('ToolRegistry', () => {
  it('registers, exposes specs, and dispatches by name', async () => {
    const reg = new ToolRegistry()
    reg.register({ spec: { name: 'echo', description: 'echoes', schema: { type: 'object' } }, handler: async a => `got:${JSON.stringify(a)}` })
    expect(reg.has('echo')).toBe(true)
    expect(reg.specs()).toEqual([{ name: 'echo', description: 'echoes', schema: { type: 'object' } }])
    expect(await reg.call('echo', { x: 1 })).toBe('got:{"x":1}')
  })

  it('throws on an unknown tool', async () => {
    const reg = new ToolRegistry()
    await expect(reg.call('nope', {})).rejects.toThrow(/unknown tool/i)
  })

  it('rejects a duplicate registration (no silent shadowing)', () => {
    const reg = new ToolRegistry()
    const t = { spec: { name: 'x', description: 'd', schema: {} }, handler: async () => 'ok' }
    reg.register(t)
    expect(() => reg.register(t)).toThrow(/already registered/i)
  })
})
