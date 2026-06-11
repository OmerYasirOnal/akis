import { describe, it, expect } from 'vitest'
import { loadThread, saveThread, clearThread, clearAllThreads, renameThread, migrateLegacyKey, anchorKey, DRAFT_KEY, historyForApi, isNearBottom, isMsg, isRun, mergeSpine, type AkisMsg, type ThreadNode, type RunNode } from './akisThread.js'

// The legacy single global key (pre per-conversation keying) — migrated forward by migrateLegacyKey.
const LEGACY_KEY = 'akis_chat_thread'

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
  it('round-trips a thread through storage under the draft key', () => {
    const store = memStore()
    const msgs: AkisMsg[] = [
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'build a todo app' },
      { role: 'assistant', content: 'Sure!' },
    ]
    saveThread(msgs, DRAFT_KEY, store)
    expect(loadThread(DRAFT_KEY, store)).toEqual(msgs)
  })

  it('returns [] for absent or malformed storage (never throws)', () => {
    expect(loadThread(DRAFT_KEY, memStore())).toEqual([])
    expect(loadThread(DRAFT_KEY, memStore({ [DRAFT_KEY]: 'not json' }))).toEqual([])
    expect(loadThread(DRAFT_KEY, memStore({ [DRAFT_KEY]: '{"not":"an array"}' }))).toEqual([])
  })

  it('drops malformed entries (wrong shape / bad role)', () => {
    const store = memStore({
      [DRAFT_KEY]: JSON.stringify([
        { role: 'user', content: 'ok' },
        { role: 'system', content: 'bad role' },
        { role: 'assistant' },
        'nope',
        { role: 'error', content: 'rendered but never sent' },
      ]),
    })
    expect(loadThread(DRAFT_KEY, store)).toEqual([
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
    saveThread(nodes, anchorKey('s1'), store)
    expect(loadThread(anchorKey('s1'), store)).toEqual(nodes)
  })

  it('drops malformed run markers (missing sessionId/idea) but keeps valid ones', () => {
    const store = memStore({
      [DRAFT_KEY]: JSON.stringify([
        { role: 'user', content: 'ok' },
        { role: 'run', sessionId: 's1', idea: '# App' },
        { role: 'run', sessionId: 's2' },              // missing idea
        { role: 'run', idea: 'no session' },           // missing sessionId
        { role: 'run', sessionId: 5, idea: '# App' },  // wrong type
      ]),
    })
    expect(loadThread(DRAFT_KEY, store)).toEqual([
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

// PER-CONVERSATION KEYING — the H1 fix (a switch A→B→A no longer clobbers either spine) + the
// draft→anchor promotion + the logout wipe + the legacy migration.
describe('akisThread per-conversation keying', () => {
  it('keeps two conversations under distinct keys (switching never clobbers either)', () => {
    const store = memStore()
    const a: ThreadNode[] = [{ role: 'user', content: 'conversation A' }, { role: 'run', sessionId: 'a', idea: 'A' }]
    const b: ThreadNode[] = [{ role: 'user', content: 'conversation B' }, { role: 'run', sessionId: 'b', idea: 'B' }]
    saveThread(a, anchorKey('a'), store)
    saveThread(b, anchorKey('b'), store)
    // Returning to A finds A intact; B is untouched — the clobber the single global key caused is gone.
    expect(loadThread(anchorKey('a'), store)).toEqual(a)
    expect(loadThread(anchorKey('b'), store)).toEqual(b)
  })

  it('renameThread promotes the draft spine to a build anchor (draft removed)', () => {
    const store = memStore()
    const draft: ThreadNode[] = [{ role: 'assistant', content: 'GREETING' }, { role: 'user', content: 'a todo app' }]
    saveThread(draft, DRAFT_KEY, store)
    renameThread(DRAFT_KEY, anchorKey('s1'), store)
    expect(loadThread(anchorKey('s1'), store)).toEqual(draft) // moved verbatim
    expect(store.getItem(DRAFT_KEY)).toBeNull()               // source dropped
  })

  it('renameThread is a no-op when from===to (a multi-run thread keeps accreting on its anchor)', () => {
    const store = memStore()
    const spine: ThreadNode[] = [{ role: 'run', sessionId: 's1', idea: 'A' }]
    saveThread(spine, anchorKey('s1'), store)
    renameThread(anchorKey('s1'), anchorKey('s1'), store)
    expect(loadThread(anchorKey('s1'), store)).toEqual(spine)
  })

  it('clearThread drops only the named conversation; others survive', () => {
    const store = memStore()
    saveThread([{ role: 'user', content: 'A' }], anchorKey('a'), store)
    saveThread([{ role: 'user', content: 'B' }], anchorKey('b'), store)
    clearThread(anchorKey('a'), store)
    expect(loadThread(anchorKey('a'), store)).toEqual([])
    expect(loadThread(anchorKey('b'), store)).toEqual([{ role: 'user', content: 'B' }])
  })

  it('clearAllThreads wipes the legacy key, the draft, AND every anchor (logout cross-user-leak fix)', () => {
    const store = memStore({
      [LEGACY_KEY]: '[]',
      [DRAFT_KEY]: '[]',
      [anchorKey('s1')]: '[]',
      [anchorKey('s2')]: '[]',
      'unrelated_key': 'keep me', // a non-spine key must NOT be touched
    })
    clearAllThreads(store)
    expect(store.getItem(LEGACY_KEY)).toBeNull()
    expect(store.getItem(DRAFT_KEY)).toBeNull()
    expect(store.getItem(anchorKey('s1'))).toBeNull()
    expect(store.getItem(anchorKey('s2'))).toBeNull()
    expect(store.getItem('unrelated_key')).toBe('keep me')
  })
})

describe('migrateLegacyKey (one-time forward migration of the old single key)', () => {
  it('migrates a pre-build legacy spine to the draft key', () => {
    const store = memStore({ [LEGACY_KEY]: JSON.stringify([{ role: 'user', content: 'an idea' }]) })
    migrateLegacyKey(store)
    expect(loadThread(DRAFT_KEY, store)).toEqual([{ role: 'user', content: 'an idea' }])
    expect(store.getItem(LEGACY_KEY)).toBeNull()
  })

  it('migrates a legacy spine that ALREADY anchors a build to that run\'s anchor key', () => {
    // The H1+legacy case: an old install with a run marker must keep its OWN spine so a ?s= reopen
    // of that build finds it (not the draft) — otherwise the rebuild branch would scramble the order.
    const legacy: ThreadNode[] = [
      { role: 'assistant', content: 'GREETING' },
      { role: 'user', content: 'Expense tracker' },
      { role: 'run', sessionId: 'b8c0', idea: 'Expense tracker' },
    ]
    const store = memStore({ [LEGACY_KEY]: JSON.stringify(legacy) })
    migrateLegacyKey(store)
    expect(loadThread(anchorKey('b8c0'), store)).toEqual(legacy)
    expect(store.getItem(DRAFT_KEY)).toBeNull()
    expect(store.getItem(LEGACY_KEY)).toBeNull()
  })

  it('is a no-op when the legacy key is absent', () => {
    const store = memStore({ [anchorKey('s1')]: '[]' })
    migrateLegacyKey(store)
    expect(store.getItem(anchorKey('s1'))).toBe('[]')
  })

  it('does NOT clobber a destination that already has a (newer) spine', () => {
    const newer: ThreadNode[] = [{ role: 'user', content: 'newer same-conversation write' }]
    const store = memStore({
      [LEGACY_KEY]: JSON.stringify([{ role: 'user', content: 'stale legacy' }]),
      [DRAFT_KEY]: JSON.stringify(newer),
    })
    migrateLegacyKey(store)
    expect(loadThread(DRAFT_KEY, store)).toEqual(newer) // the newer write wins
    expect(store.getItem(LEGACY_KEY)).toBeNull()        // legacy still dropped
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

  // H2 — the rebuild must be CHRONOLOGIC: the run marker sits AFTER the pre-build conversation that
  // produced it, BEFORE any post-build follow-up. The old rebuild put the marker before ALL restored
  // turns, so a cross-device/cleared reopen rendered the run block above the conversation (the bug).
  it('places the run marker AFTER phase:pre turns and BEFORE post-build turns (the reorder fix)', () => {
    const out = mergeSpine({
      local: [],
      serverTurns: [
        { role: 'user', content: 'Expense tracker', phase: 'pre' },
        { role: 'assistant', content: 'Here is a spec', phase: 'pre' },
        { role: 'user', content: 'why did tests fail?' },     // post-build follow-up (no phase)
        { role: 'assistant', content: 'the verify step…' },   // post-build follow-up (no phase)
      ],
      id: 's1', greeting: 'GREETING', idea: 'Expense tracker',
    })
    expect(out).toEqual([
      { role: 'assistant', content: 'GREETING' },
      { role: 'user', content: 'Expense tracker' },
      { role: 'assistant', content: 'Here is a spec' },
      { role: 'run', sessionId: 's1', idea: 'Expense tracker' },
      { role: 'user', content: 'why did tests fail?' },
      { role: 'assistant', content: 'the verify step…' },
    ])
    // The run marker is strictly below the conversation that produced it.
    const runIdx = out.findIndex(isRun)
    const specIdx = out.findIndex(n => isMsg(n) && n.content === 'Here is a spec')
    const followIdx = out.findIndex(n => isMsg(n) && n.content === 'why did tests fail?')
    expect(specIdx).toBeLessThan(runIdx)
    expect(runIdx).toBeLessThan(followIdx)
  })

  it('places UNTAGGED legacy server turns AFTER the marker (preserves the old [greeting, run, …turns] render)', () => {
    // Rows persisted before the phase tag have no `phase` — they keep landing UNDER the marker, the
    // same place the old rebuild put them, so a legacy reopen reads exactly as it did before.
    const out = mergeSpine({
      local: [],
      serverTurns: [{ role: 'user', content: 'old turn' }, { role: 'assistant', content: 'old reply' }],
      id: 's1', greeting: 'GREETING', idea: 'note app',
    })
    expect(out).toEqual([
      { role: 'assistant', content: 'GREETING' },
      { role: 'run', sessionId: 's1', idea: 'note app' },
      { role: 'user', content: 'old turn' },
      { role: 'assistant', content: 'old reply' },
    ])
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
