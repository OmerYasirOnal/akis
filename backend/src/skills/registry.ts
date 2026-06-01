import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import type { Role } from '@akis/shared'

export interface Skill {
  name: string
  description: string
  appliesToRole: Role
  triggers: string[]
  status: 'draft' | 'validated'
  version: string
  body: string
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.md')) out.push(p)
  }
  return out
}

export function loadSkills(dir: string): Skill[] {
  return walk(dir).map(p => {
    const { data, content } = matter(readFileSync(p, 'utf8'))
    return {
      name: String(data.name),
      description: String(data.description ?? ''),
      appliesToRole: data.appliesToRole as Role,
      triggers: (data.triggers ?? []) as string[],
      status: (data.status ?? 'draft') as Skill['status'],
      version: String(data.version ?? '0.0.0'),
      body: content.trim(),
    }
  })
}

export interface SelectArgs { role: Role; request: string }

export function selectSkills(reg: Skill[], { role, request }: SelectArgs): Skill[] {
  const q = request.toLowerCase()
  return reg.filter(s => s.appliesToRole === role && s.triggers.some(t => q.includes(t.toLowerCase())))
}

export function buildSystemPrompt(base: string, skills: Skill[]): string {
  if (!skills.length) return base
  const blocks = skills.map(s => `## Skill: ${s.name} (${s.status})\n${s.body}`).join('\n\n')
  return `${base}\n\n# Injected skills\n\n${blocks}`
}
