import { describe, it, expect } from 'vitest'
import { loadThread, saveThread, historyForApi, isNearBottom, isMsg, isRun, mergeSpine, type AkisMsg, type ThreadNode, type RunNode } from './akisThread.js'

function memStore(initial: Record<string, string> = {}): Storage & { _data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    _data: data,
    getItem: (k: string) => (k in data ? data[k]! : null),
    setItem: (k: string, v: string) => { data[k] = v },
    removeItem: (k: string) => { delete data[k] },
    clear: () => { for (const k of Object.keys(data)) delete data[k] },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() { return Object.keys(data).length },
  } as Storage & { _data: Record<string, string> }
}

describe('akisThread persistence', () => {
  it('round-trips a thread through storage', () => {
    const store = memStore()
    const msgs: AkisMsg[] = [
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'build a todo app' },
      { role: 'assistant', content: 'Sure!' },
    ]
    saveThread(msgs, store)
    expect(loadThread(store)).toEqual(msgs)
  })

  it('returns [] for absent or malformed storage (never throws)', () => {
    expect(loadThread(memStore())).toEqual([])
    expect(loadThread(memStore({ akis_chat_thread: 'not json' }))).toEqual([])
    expect(loadThread(memStore({ akis_chat_thread: '{"not":"an array"}' }))).toEqual([])
  })

  it('drops malformed entries (wrong shape / bad role)', () => {
    const store = memStore({
      akis_chat_thread: JSON.stringify([
        { role: 'user', content: 'ok' },
        { role: 'system', content: 'bad role' },
        { role: 'assistant' },
        'nope',
        { role: 'error', content: 'rendered but never sent' },
      ]),
    })
    expect(loadThread(store)).toEqual([
      { role: 'user', content: 'ok' },
      { role: 'error', content: 'rendered but never sent' },
    ])
  })

  it('round-trips run markers in the SAME key, interleaved with chat messages (the spine)', () => {
    const store = memStore()
    const nodes: ThreadNode[] = [
      { role: 'user', content: 'build a todo app' },
      { role: 'assistant', content: 'Here is a spec…' },
      { role: 'run', sessionId: 's1', idea: '# Todo App' },
      { role: 'user', content: 'add a login page' },
      { role: 'run', sessionId: 's2', idea: '# Todo App + Login' },
    ]
    saveThread(nodes, store)
    expect(loadThread(store)).toEqual(nodes)
  })

  it('drops malformed run markers (missing sessionId/idea) but keeps valid ones', () => {
    const store = memStore({
      akis_chat_thread: JSON.stringify([
        { role: 'user', content: 'ok' },
        { role: 'run', sessionId: 's1', idea: '# App' },
        { role: 'run', sessionId: 's2' },              // missing idea
        { role: 'run', idea: 'no session' },           // missing sessionId
        { role: 'run', sessionId: 5, idea: '# App' },  // wrong type
      ]),
    })
    expect(loadThread(store)).toEqual([
      { role: 'user', content: 'ok' },
      { role: 'run', sessionId: 's1', idea: '# App' },
    ])
  })

  it('isMsg / isRun discriminate the spine node kinds', () => {
    const msg: ThreadNode = { role: 'user', content: 'hi' }
    const run: RunNode = { role: 'run', sessionId: 's1', idea: '# App' }
    expect(isMsg(msg)).toBe(true)
    expect(isMsg(run)).toBe(false)
    expect(isRun(run)).toBe(true)
    expect(isRun(msg)).toBe(false)
  })
})

describe('historyForApi', () => {
  const greeting = 'Hi, I’m AKIS.'

  it('excludes the greeting (assistant) but keeps later turns', () => {
    const msgs: AkisMsg[] = [
      { role: 'assistant', content: greeting },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ]
    expect(historyForApi(msgs, greeting)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
    ])
  })

  it('EXCLUDES error rows so a failure never poisons AKIS context', () => {
    const msgs: AkisMsg[] = [
      { role: 'user', content: 'q1' },
      { role: 'error', content: '(ProviderError) upstream 502' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ]
    expect(historyForApi(msgs, greeting)).toEqual([
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ])
    // history must only ever carry the two API roles, never 'error'
    expect(historyForApi(msgs, greeting).every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
  })

  it('keeps a user message that happens to equal the greeting text', () => {
    const msgs: AkisMsg[] = [{ role: 'user', content: greeting }]
    expect(historyForApi(msgs, greeting)).toEqual([{ role: 'user', content: greeting }])
  })

  it('SKIPS run markers so build-aware history never bloats with run data', () => {
    const nodes: ThreadNode[] = [
      { role: 'user', content: 'build a todo app' },
      { role: 'assistant', content: 'spec…' },
      { role: 'run', sessionId: 's1', idea: '# A very long spec body that must never reach history' },
      { role: 'user', content: 'add login' },
    ]
    expect(historyForApi(nodes, greeting)).toEqual([
      { role: 'user', content: 'build a todo app' },
      { role: 'assistant', content: 'spec…' },
      { role: 'user', content: 'add login' },
    ])
    // never a run node nor anything but the two API roles
    expect(historyForApi(nodes, greeting).every(m => m.role === 'user' || m.role === 'assistant')).toBe(true)
  })
})

describe('mergeSpine (reconcile local spine with server chat on reopen)', () => {
  const greet = (): ThreadNode => ({ role: 'assistant', content: 'GREETING' })
  const run = (id: string): ThreadNode => ({ role: 'run', sessionId: id, idea: 'note app' })

  it('keeps the richer LOCAL spine when it already has the run marker (pre-build turns survive)', () => {
    // The local spine is the only place the pre-build, sessionId-less turns live; the server can
    // never hold them. When it already anchors this run, a THINNER server chat must not clobber it.
    const local: ThreadNode[] = [greet(), { role: 'user', content: 'a note app' }, { role: 'assistant', content: 'sure' }, run('s1')]
    const out = mergeSpine({ local, serverTurns: [{ role: 'assistant', content: 'sure' }], id: 's1', greeting: 'GREETING', idea: 'note app' })
    expect(out).toEqual(local)
  })

  it('falls back to greeting+runMarker+serverTurns when local has no marker for the id (cleared storage / another device)', () => {
    const out = mergeSpine({ local: [], serverTurns: [{ role: 'user', content: 'hi' }], id: 's1', greeting: 'GREETING', idea: 'note app' })
    expect(out).toEqual([greet(), run('s1'), { role: 'user', content: 'hi' }])
  })

  it('does NOT fall back to the rebuild branch when the local marker is for a DIFFERENT id', () => {
    // A marker for s2 must not satisfy the s1 reopen — rebuild from server turns for s1.
    const local: ThreadNode[] = [greet(), { role: 'user', content: 'other build' }, run('s2')]
    const out = mergeSpine({ local, serverTurns: [{ role: 'user', content: 'hi' }], id: 's1', greeting: 'GREETING', idea: 'note app' })
    expect(out).toEqual([greet(), run('s1'), { role: 'user', content: 'hi' }])
  })

  it('dedupes adjacent identical turns', () => {
    const out = mergeSpine({ local: [], serverTurns: [{ role: 'user', content: 'hi' }, { role: 'user', content: 'hi' }], id: 's1', greeting: 'GREETING', idea: 'x' })
    expect(out.filter(n => 'content' in n && n.content === 'hi')).toHaveLength(1)
  })
})

describe('isNearBottom (auto-scroll guard)', () => {
  it('is true when scrolled to the very bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 800, clientHeight: 200 })).toBe(true)
  })

  it('is true within the slack window just above the bottom', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 785, clientHeight: 200 })).toBe(true)
  })

  it('is FALSE once the user has scrolled up to read earlier history', () => {
    expect(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 200 })).toBe(false)
  })
})
