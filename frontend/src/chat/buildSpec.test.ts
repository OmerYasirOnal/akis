import { describe, it, expect } from 'vitest'
import { extractBuildSpec } from './buildSpec.js'

describe('extractBuildSpec', () => {
  it('returns null when there is no akis-spec block', () => {
    expect(extractBuildSpec('Just a friendly reply, no spec here.')).toBeNull()
  })

  it('extracts the spec content from a fenced akis-spec block', () => {
    const msg = '```akis-spec\n# TODO App\nA simple list.\n```'
    const out = extractBuildSpec(msg)
    expect(out).not.toBeNull()
    expect(out?.spec).toBe('# TODO App\nA simple list.')
    expect(out?.intro).toBe('')
  })

  it('captures the intro text before the block', () => {
    const msg = "Here's a spec you can build 👇\n```akis-spec\n# TODO App\n```"
    const out = extractBuildSpec(msg)
    expect(out?.intro).toBe("Here's a spec you can build 👇")
    expect(out?.spec).toBe('# TODO App')
  })

  it('returns the FIRST block when multiple are present', () => {
    const msg = '```akis-spec\nfirst\n```\nmiddle\n```akis-spec\nsecond\n```'
    const out = extractBuildSpec(msg)
    expect(out?.spec).toBe('first')
  })

  it('returns null for an unclosed fence (graceful)', () => {
    const msg = 'intro\n```akis-spec\n# TODO App\nno closing fence'
    expect(extractBuildSpec(msg)).toBeNull()
  })

  it('tolerates extra info-string tokens after akis-spec (e.g. a version)', () => {
    const msg = '```akis-spec v=2\nbody\n```'
    const out = extractBuildSpec(msg)
    expect(out?.spec).toBe('body')
  })

  it('trims a trailing newline inside the block but preserves inner content', () => {
    const msg = '```akis-spec\nline1\n\nline2\n```'
    expect(extractBuildSpec(msg)?.spec).toBe('line1\n\nline2')
  })

  it('does not match a plain code fence (different info string)', () => {
    expect(extractBuildSpec('```ts\nconst x = 1\n```')).toBeNull()
  })
})
