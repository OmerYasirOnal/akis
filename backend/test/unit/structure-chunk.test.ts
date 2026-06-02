import { describe, it, expect } from 'vitest'
import { chunkByKind } from '../../src/knowledge/ingest/structureChunk.js'

const WINDOW = 800

describe('chunkByKind: prose', () => {
  it('groups by paragraph and keeps no chunk over the window', () => {
    const para = (n: number): string => `Paragraph ${n}. ` + 'word '.repeat(20)
    const text = [para(1), para(2), para(3), para(4)].join('\n\n')
    const chunks = chunkByKind(text, 'prose')
    expect(chunks.length).toBeGreaterThan(0)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WINDOW)
    // every paragraph's distinctive marker survives somewhere
    const joined = chunks.join('\n')
    expect(joined).toContain('Paragraph 1.')
    expect(joined).toContain('Paragraph 4.')
  })

  it('windows a single oversized paragraph that exceeds the window', () => {
    const huge = 'lorem ipsum dolor '.repeat(200) // ~3600 chars, one paragraph
    const chunks = chunkByKind(huge, 'prose')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WINDOW)
  })
})

describe('chunkByKind: markdown / spec', () => {
  it('splits on ATX headings into per-section chunks', () => {
    const md = [
      '# Title',
      'intro line',
      '## Auth',
      'login and logout flow',
      '## Payments',
      'stripe billing invoices',
    ].join('\n')
    const chunks = chunkByKind(md, 'markdown')
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    // each heading anchors its own section
    expect(chunks.some(c => c.includes('## Auth') && c.includes('login and logout'))).toBe(true)
    expect(chunks.some(c => c.includes('## Payments') && c.includes('stripe billing'))).toBe(true)
  })

  it('windows an oversized section so no chunk exceeds the window', () => {
    const md = '## Big Section\n' + 'detail line about the system. '.repeat(120)
    const chunks = chunkByKind(md, 'markdown')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WINDOW)
  })
})

describe('chunkByKind: code', () => {
  it('splits at top-level symbol boundaries, keeping a small body intact', () => {
    const code = [
      'export function alpha() {',
      '  return 1',
      '}',
      '',
      'export function beta() {',
      '  return 2',
      '}',
      '',
      'class Gamma {',
      '  go() { return 3 }',
      '}',
    ].join('\n')
    const chunks = chunkByKind(code, 'code')
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    // each symbol body stays together within one chunk
    expect(chunks.some(c => c.includes('function alpha') && c.includes('return 1'))).toBe(true)
    expect(chunks.some(c => c.includes('function beta') && c.includes('return 2'))).toBe(true)
    expect(chunks.some(c => c.includes('class Gamma') && c.includes('return 3'))).toBe(true)
  })

  it('windows an oversized single symbol body so no chunk exceeds the window', () => {
    const body = Array.from({ length: 120 }, (_, i) => `  const v${i} = ${i} + somethingLong()`).join('\n')
    const code = `function big() {\n${body}\n}`
    const chunks = chunkByKind(code, 'code')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WINDOW)
  })

  it('falls back to chunkText when there are no detectable top-level symbols', () => {
    const unstructured = 'just a line\nanother line\nyet another line without braces or symbols'
    const chunks = chunkByKind(unstructured, 'code')
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain('just a line')
  })
})

describe('chunkByKind: empty / whitespace', () => {
  it('returns [] for empty or whitespace-only text across all kinds', () => {
    for (const kind of ['prose', 'markdown', 'code', 'pdf'] as const) {
      expect(chunkByKind('', kind)).toEqual([])
      expect(chunkByKind('   \n\t  \n', kind)).toEqual([])
    }
  })
})

describe('chunkByKind: pdf falls back to prose handling', () => {
  it('treats pdf text as prose (paragraph grouping, windowed)', () => {
    const text = 'first para here.\n\nsecond para here.'
    const chunks = chunkByKind(text, 'pdf')
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.join('\n')).toContain('first para')
    expect(chunks.join('\n')).toContain('second para')
  })
})
