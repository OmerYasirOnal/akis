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
})
