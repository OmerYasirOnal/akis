import { describe, it, expect } from 'vitest'
import { extractBuildSpec, hasTruncatedSpec } from './buildSpec.js'

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

  it('does NOT truncate a 4-backtick block that contains an inner ```code fence (the real-spec case)', () => {
    // A build spec routinely embeds code examples; a 4-backtick outer fence must contain
    // inner 3-backtick blocks instead of closing at the first inner ``` (the must-fix).
    const spec = '# API\nExample:\n```js\nconst x = 1\n```\nThat is the whole spec.'
    const out = extractBuildSpec('````akis-spec\n' + spec + '\n````')
    expect(out?.spec).toBe(spec)
  })

  it('detects a fence indented up to 3 spaces (CommonMark)', () => {
    const out = extractBuildSpec('   ```akis-spec\nbody\n   ```')
    expect(out?.spec).toBe('body')
  })

  it('does NOT treat `akis-spec-v2` (no separator) as the akis-spec tag', () => {
    expect(extractBuildSpec('```akis-spec-v2\nbody\n```')).toBeNull()
  })
})

describe('hasTruncatedSpec', () => {
  it('is true when an akis-spec fence opened but never closed (cut mid-stream)', () => {
    const msg = "Here's the spec 👇\n````akis-spec\n# Big App\nlots of detail that got cut off"
    expect(hasTruncatedSpec(msg)).toBe(true)
  })

  it('is false when the akis-spec block is properly closed (extractBuildSpec succeeds)', () => {
    const msg = '````akis-spec\n# App\nbody\n````'
    expect(hasTruncatedSpec(msg)).toBe(false)
    expect(extractBuildSpec(msg)).not.toBeNull()
  })

  it('is false for prose with no akis-spec fence at all', () => {
    expect(hasTruncatedSpec('Just a friendly reply with no spec.')).toBe(false)
  })

  it('does NOT consider an inner ```code fence as the akis-spec opener (3-space tolerant)', () => {
    expect(hasTruncatedSpec('```ts\nconst x = 1\n```')).toBe(false)
  })

  it('is false once a truncated block is followed by a matching closing fence', () => {
    // A 3-backtick opener closed by a 3-backtick fence is complete, not truncated.
    expect(hasTruncatedSpec('```akis-spec\n# App\nbody\n```')).toBe(false)
  })
})
