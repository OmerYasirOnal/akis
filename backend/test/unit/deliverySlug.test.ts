/**
 * Per-project repo-name derivation (A2.1) — pure slugify + collision-suffix rules. Pins the
 * TR-safety folds, length cap, dash collapse, the title→idea→default fallback chain, and the
 * deterministic `-2`/`-3` collision suffix the destination resolver layers on top.
 */
import { describe, it, expect } from 'vitest'
import { slugifyRepoName, deriveRepoName, suffixedRepoName, resolveAvailableRepoName, MAX_REPO_NAME, MAX_COLLISION_PROBES } from '../../src/di/deliverySlug.js'

describe('slugifyRepoName', () => {
  it('lowercases + dashes a plain English title', () => {
    expect(slugifyRepoName('Todo App')).toBe('todo-app')
    expect(slugifyRepoName('My Cool Project')).toBe('my-cool-project')
  })

  it('folds Turkish-specific letters to ASCII (ı İ ş ğ ü ö ç)', () => {
    expect(slugifyRepoName('Görev Takip Çizelgesi')).toBe('gorev-takip-cizelgesi')
    expect(slugifyRepoName('Şık Düğün Planı')).toBe('sik-dugun-plani')
    // dotless ı and capital dotted İ both → 'i'
    expect(slugifyRepoName('Işık İstasyonu')).toBe('isik-istasyonu')
    expect(slugifyRepoName('ÖĞÜ')).toBe('ogu')
  })

  it('strips generic diacritics (é ñ ü) via NFD', () => {
    expect(slugifyRepoName('Café Niño')).toBe('cafe-nino')
  })

  it('collapses runs of non-alphanumeric to a single dash + trims edges', () => {
    expect(slugifyRepoName('  Hello---World!!!  ')).toBe('hello-world')
    expect(slugifyRepoName('a / b _ c . d')).toBe('a-b-c-d')
    expect(slugifyRepoName('--leading and trailing--')).toBe('leading-and-trailing')
  })

  it('caps to MAX_REPO_NAME and re-trims a trailing dash the cut exposes', () => {
    const long = 'word '.repeat(40).trim() // many "word" tokens → "word-word-word-..."
    const out = slugifyRepoName(long)
    expect(out.length).toBeLessThanOrEqual(MAX_REPO_NAME)
    expect(out.endsWith('-')).toBe(false)
    expect(out.startsWith('word-word')).toBe(true)
  })

  it('returns empty for content with no alphanumerics', () => {
    expect(slugifyRepoName('!!!')).toBe('')
    expect(slugifyRepoName('   ')).toBe('')
    expect(slugifyRepoName('')).toBe('')
  })
})

describe('deriveRepoName (title → idea → default)', () => {
  it('prefers the spec title when present', () => {
    expect(deriveRepoName('Görev Takip', 'a todo app idea')).toBe('gorev-takip')
  })

  it('falls back to the idea when the title is missing/blank', () => {
    expect(deriveRepoName(undefined, 'A Simple Todo App')).toBe('a-simple-todo-app')
    expect(deriveRepoName('   ', 'Recipe Box')).toBe('recipe-box')
    expect(deriveRepoName('!!!', 'Recipe Box')).toBe('recipe-box')
  })

  it('falls back to the stable default when neither slugs', () => {
    expect(deriveRepoName('🎉🎉', '!!!')).toBe('akis-app')
  })
})

describe('suffixedRepoName (collision)', () => {
  it('attempt 0 is the bare base', () => {
    expect(suffixedRepoName('todo-app', 0)).toBe('todo-app')
  })

  it('attempt N appends a deterministic -(N+1) suffix', () => {
    expect(suffixedRepoName('todo-app', 1)).toBe('todo-app-2')
    expect(suffixedRepoName('todo-app', 2)).toBe('todo-app-3')
  })

  it('trims the BASE (never the suffix) to keep the whole name within the cap', () => {
    const base = 'x'.repeat(MAX_REPO_NAME) // already at the cap
    const out = suffixedRepoName(base, 9) // suffix "-10"
    expect(out.length).toBeLessThanOrEqual(MAX_REPO_NAME)
    expect(out.endsWith('-10')).toBe(true)
  })
})

describe('resolveAvailableRepoName (collision walk, fail-open)', () => {
  it('takes the bare base when it is free (probe says false)', async () => {
    const probed: string[] = []
    const repo = await resolveAvailableRepoName('todo-app', async name => { probed.push(name); return false })
    expect(repo).toBe('todo-app')
    expect(probed).toEqual(['todo-app']) // stops at the first free name
  })

  it('suffixes deterministically to -2 when the base EXISTS (probe says true)', async () => {
    const existing = new Set(['todo-app'])
    const probed: string[] = []
    const repo = await resolveAvailableRepoName('todo-app', async name => { probed.push(name); return existing.has(name) })
    expect(repo).toBe('todo-app-2')
    expect(probed).toEqual(['todo-app', 'todo-app-2'])
  })

  it('walks -2 -3 … past multiple collisions', async () => {
    const existing = new Set(['app', 'app-2', 'app-3'])
    const repo = await resolveAvailableRepoName('app', async name => existing.has(name))
    expect(repo).toBe('app-4')
  })

  it('FAILS OPEN on an UNKNOWN probe (undefined) — takes the candidate, never blocks delivery', async () => {
    const probed: string[] = []
    const repo = await resolveAvailableRepoName('todo-app', async name => { probed.push(name); return undefined })
    expect(repo).toBe('todo-app')
    expect(probed).toEqual(['todo-app']) // one probe, then take it (don't loop on flaky network)
  })

  it('is bounded — every candidate existing returns the last suffixed name (no infinite loop)', async () => {
    const repo = await resolveAvailableRepoName('app', async () => true) // everything "exists"
    expect(repo).toBe(suffixedRepoName('app', MAX_COLLISION_PROBES - 1)) // "app-5"
  })
})
