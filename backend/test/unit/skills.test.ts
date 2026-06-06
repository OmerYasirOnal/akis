import { describe, it, expect } from 'vitest'
import { loadSkills, selectSkills, buildSystemPrompt } from '../../src/skills/registry.js'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const libDir = resolve(here, '../../src/skills/library')

describe('skill registry', () => {
  it('loads .md skills with frontmatter and surfaces draft status', () => {
    const reg = loadSkills(libDir)
    const webApp = reg.find(s => s.name === 'web-app-spec')
    expect(webApp).toBeDefined()
    expect(webApp!.appliesToRole).toBe('scribe')
    expect(webApp!.status).toBe('draft')
  })
  it('selects skills by role + trigger', () => {
    const reg = loadSkills(libDir)
    expect(selectSkills(reg, { role: 'scribe', request: 'build me a web app' }).some(s => s.name === 'web-app-spec')).toBe(true)
    expect(selectSkills(reg, { role: 'trace', request: 'build me a web app' }).some(s => s.name === 'web-app-spec')).toBe(false)
  })
  it('builds a system prompt = base + injected skills', () => {
    const reg = loadSkills(libDir)
    const sys = buildSystemPrompt('BASE', selectSkills(reg, { role: 'scribe', request: 'web app' }))
    expect(sys).toContain('BASE')
    expect(sys).toContain('web-app-spec')
  })

  it('every library skill is status:draft and has required frontmatter', () => {
    const reg = loadSkills(libDir)
    expect(reg.length).toBeGreaterThanOrEqual(10)
    const validRoles = ['orchestrator', 'scribe', 'proto', 'trace', 'critic']
    for (const s of reg) {
      expect(s.status).toBe('draft')
      expect(s.name).toBeTruthy()
      expect(validRoles).toContain(s.appliesToRole)
      expect(Array.isArray(s.triggers)).toBe(true)
      expect(s.triggers.length).toBeGreaterThan(0)
      expect(s.body.length).toBeGreaterThan(0)
    }
  })
})

describe('loadSkillsCached (perf quick-win: one disk walk per dir per process)', () => {
  it('returns the SAME array instance for a repeat dir (no re-walk) and caches dirs independently', async () => {
    const { loadSkillsCached } = await import('../../src/skills/registry.js')
    const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dirA = mkdtempSync(join(tmpdir(), 'akis-skills-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'akis-skills-b-'))
    mkdirSync(join(dirA, 'x'), { recursive: true })
    writeFileSync(join(dirA, 'x', 's.md'), '---\nname: a-skill\nappliesToRole: proto\n---\nbody')
    const first = loadSkillsCached(dirA)
    expect(first.map(s => s.name)).toEqual(['a-skill'])
    // A mutation AFTER the first load is intentionally NOT picked up (immutable-library contract);
    // the cache hands back the same instance instead of re-walking the tree.
    writeFileSync(join(dirA, 'x', 's2.md'), '---\nname: late-skill\nappliesToRole: proto\n---\nbody')
    expect(loadSkillsCached(dirA)).toBe(first)
    // A DIFFERENT dir is its own cache entry.
    expect(loadSkillsCached(dirB)).toEqual([])
  })
})
