import { describe, it, expect } from 'vitest'
import { extractSpecRequest, stripSpecRequest, hasSpecRequest } from '../../src/api/specRequest.js'

/**
 * The HANDOFF contract: when the conversation is ready to spec, the chat persona STOPS
 * authoring a full spec and instead emits a compact `akis-spec-request` fence carrying a
 * one-line brief. The chat route detects this post-stream and hands off to the REAL Scribe.
 *
 * The request fence is held to the SAME strictness as the old `akis-spec` fence
 * (buildSpec.ts): backtick-count-aware (a run of N>=3, closing run matches), indent-tolerant
 * (<=3 spaces), and the info string is a COMPLETE token (`akis-spec-request`, never
 * `akis-spec-requestX`). It must NOT collide with the build `akis-spec` fence.
 */
describe('extractSpecRequest — the chat→Scribe handoff fence', () => {
  it('extracts the brief from a four-backtick akis-spec-request fence', () => {
    const msg = 'Great, let me get Scribe on this.\n````akis-spec-request\nA todo app with due dates and a dark theme\n````'
    const r = extractSpecRequest(msg)
    expect(r).not.toBeNull()
    expect(r!.brief).toBe('A todo app with due dates and a dark theme')
    expect(r!.intro).toBe('Great, let me get Scribe on this.')
  })

  it('preserves a multi-line brief verbatim (trimmed)', () => {
    const msg = '````akis-spec-request\nApp: invoice tracker\nMust: PDF export, search\n````'
    const r = extractSpecRequest(msg)
    expect(r!.brief).toBe('App: invoice tracker\nMust: PDF export, search')
  })

  it('is backtick-count-aware: an inner ```code block does not close the request fence', () => {
    const msg = '````akis-spec-request\nA REPL that runs ```js console.log(1)``` snippets\n````'
    const r = extractSpecRequest(msg)
    expect(r!.brief).toBe('A REPL that runs ```js console.log(1)``` snippets')
  })

  it('tolerates <=3 leading spaces on the fence lines (CommonMark)', () => {
    const msg = '   ````akis-spec-request\n   build a kanban board\n   ````'
    expect(extractSpecRequest(msg)!.brief).toBe('build a kanban board')
  })

  it('returns null on an empty brief (no half-formed handoff)', () => {
    const msg = '````akis-spec-request\n\n````'
    expect(extractSpecRequest(msg)).toBeNull()
  })

  it('returns null when there is no request fence', () => {
    expect(extractSpecRequest('just a normal reply')).toBeNull()
  })

  it('returns null for an UNCLOSED request fence (a truncated reply degrades, never half-handoff)', () => {
    expect(extractSpecRequest('````akis-spec-request\na todo app')).toBeNull()
  })

  it('does NOT match a build `akis-spec` fence (the two contracts never collide)', () => {
    const msg = '````akis-spec\n# Todo\nbody\n````'
    expect(extractSpecRequest(msg)).toBeNull()
  })

  it('requires the info string to be a COMPLETE token (akis-spec-requestX is NOT a match)', () => {
    const msg = '````akis-spec-requestX\nbrief\n````'
    expect(extractSpecRequest(msg)).toBeNull()
  })

  it('non-string input → null (defensive)', () => {
    expect(extractSpecRequest(undefined as unknown as string)).toBeNull()
  })
})

describe('stripSpecRequest — remove the internal handoff marker from the visible reply', () => {
  it('removes the request fence and returns the surrounding prose only', () => {
    const msg = 'On it — Scribe will draft this.\n````akis-spec-request\na todo app\n````\n'
    expect(stripSpecRequest(msg)).toBe('On it — Scribe will draft this.')
  })

  it('leaves a reply without a request fence unchanged', () => {
    expect(stripSpecRequest('hello')).toBe('hello')
  })
})

describe('hasSpecRequest', () => {
  it('true only when a closed request fence is present', () => {
    expect(hasSpecRequest('````akis-spec-request\nx\n````')).toBe(true)
    expect(hasSpecRequest('````akis-spec-request\nx')).toBe(false)
    expect(hasSpecRequest('no fence')).toBe(false)
  })
})
