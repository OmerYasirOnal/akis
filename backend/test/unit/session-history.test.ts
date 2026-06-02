import { describe, it, expect } from 'vitest'
import { MockSessionStore } from '../../src/store/MockSessionStore.js'
import { initialSession } from '@akis/shared'

describe('MockSessionStore.listByOwner', () => {
  it('returns a user\'s sessions newest-first and isolates other users', async () => {
    const s = new MockSessionStore()
    await s.create(initialSession('a1', 'first app', 'user-1'))
    await s.create(initialSession('a2', 'second app', 'user-1'))
    await s.create(initialSession('b1', 'other user app', 'user-2'))
    await s.create(initialSession('anon', 'anon app')) // no owner

    const mine = await s.listByOwner('user-1')
    expect(mine.map(x => x.id)).toEqual(['a2', 'a1']) // newest first
    expect((await s.listByOwner('user-2')).map(x => x.id)).toEqual(['b1'])
    expect(await s.listByOwner('nobody')).toEqual([])
  })

  it('initialSession records ownerId only when provided', () => {
    expect(initialSession('x', 'i', 'u').ownerId).toBe('u')
    expect(initialSession('x', 'i').ownerId).toBeUndefined()
  })
})
