import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileSessionStore } from '../../src/store/JsonFileSessionStore.js'
import { EventBus } from '../../src/events/bus.js'
import { initialSession, type AkisEvent } from '@akis/shared'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'akis-devsess-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const file = (): string => join(dir, 'dev-sessions.json')

describe('JsonFileSessionStore (builds survive a dev restart — the recurring live pain)', () => {
  it('create/update round-trips through a RESTART (a fresh instance hydrates the file)', async () => {
    const a = new JsonFileSessionStore(file())
    const s = initialSession('s1', 'todo app', 'user-1')
    await a.create(s)
    await a.update('s1', { status: 'building' }, 0)
    // "restart": a brand-new instance over the same file
    const b = new JsonFileSessionStore(file())
    const restored = await b.get('s1')
    expect(restored?.status).toBe('building')
    expect(restored?.version).toBe(1)
    expect(restored?.ownerId).toBe('user-1')
    expect((await b.listByOwner('user-1')).map(x => x.id)).toEqual(['s1'])
  })

  it('version-conflict semantics survive the restart (optimistic locking intact)', async () => {
    const a = new JsonFileSessionStore(file())
    await a.create(initialSession('s1', 'x'))
    await a.update('s1', { status: 'building' }, 0)
    const b = new JsonFileSessionStore(file())
    await expect(b.update('s1', { status: 'done' }, 0)).rejects.toThrow(/version conflict/)
    await expect(b.update('s1', { status: 'done' }, 1)).resolves.toMatchObject({ version: 2 })
  })

  it('a corrupted file never crashes the boot (tolerant hydrate; bad rows dropped)', async () => {
    writeFileSync(file(), '{"not":"an array"}')
    const a = new JsonFileSessionStore(file())
    expect(await a.get('anything')).toBeUndefined()
    writeFileSync(file(), JSON.stringify([{ id: 's1', status: 'done', version: 0, idea: 'ok' }, { garbage: true }, 42]))
    const b = new JsonFileSessionStore(file())
    expect((await b.get('s1'))?.status).toBe('done')
  })

  it('the file is 0600 (dev hygiene, same as dev-users)', async () => {
    const a = new JsonFileSessionStore(file())
    await a.create(initialSession('s1', 'x'))
    expect(statSync(file()).mode & 0o777).toBe(0o600)
    expect(readFileSync(file(), 'utf8')).toContain('"s1"')
  })
})

describe('EventBus snapshot/hydrate (restored sessions rebuild their FULL live view)', () => {
  const E = (sessionId: string, kind: string): AkisEvent =>
    ({ kind, agent: 'orchestrator', laneId: 'main', sessionId, ts: 1 }) as AkisEvent

  it('replaySince + head are identical across a snapshot→hydrate round-trip', () => {
    const a = new EventBus()
    a.emit(E('s1', 'narration')); a.emit(E('s1', 'agent_start')); a.emit(E('s2', 'narration'))
    const b = new EventBus()
    b.hydrate(JSON.parse(JSON.stringify(a.snapshot())) as ReturnType<EventBus['snapshot']>)
    expect(b.head('s1')).toBe(2)
    expect(b.head('s2')).toBe(1)
    const r = b.replaySince('s1', 0)
    expect(r.events.map(e => e.event.kind)).toEqual(['narration', 'agent_start'])
    // The seq head continues — a post-restart emit never reuses a seq (Last-Event-ID safe).
    b.emit(E('s1', 'done'))
    expect(b.replaySince('s1', 2).events[0]?.seq).toBe(3)
  })

  it('hydrate is tolerant (malformed shapes dropped) and respects the cap', () => {
    const b = new EventBus(3)
    b.hydrate({
      seqs: { s1: 5, bad: 'x' as unknown as number },
      buffers: {
        s1: [
          { seq: 3, event: E('s1', 'a') }, { seq: 4, event: E('s1', 'b') },
          { seq: 5, event: E('s1', 'c') }, { seq: 2, event: E('s1', 'old') },
          null as unknown as { seq: number; event: AkisEvent },
        ],
        junk: 'nope' as unknown as [],
      },
    })
    const r = b.replaySince('s1', 0)
    expect(r.events.length).toBeLessThanOrEqual(3)
    expect(b.head('bad')).toBe(0)
  })
})
