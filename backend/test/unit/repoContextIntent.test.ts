import { describe, it, expect } from 'vitest'
import { wantsRepoContext } from '../../src/orchestrator/repoContextIntent.js'

describe('wantsRepoContext — smart trigger for SP1 github read context', () => {
  it('does NOT trigger on a plain app idea (the common case — no Docker spawn)', () => {
    expect(wantsRepoContext('A tiny static notes app — add and list notes, vanilla JS, localStorage.')).toBe(false)
    expect(wantsRepoContext('Build a todo list with a calendar view')).toBe(false)
    expect(wantsRepoContext('make the button red')).toBe(false)
    expect(wantsRepoContext('A landing page for my startup with a pricing table')).toBe(false) // "my" alone ≠ repo
    expect(wantsRepoContext(undefined)).toBe(false)
    expect(wantsRepoContext('')).toBe(false)
  })

  it('triggers on an explicit repo / github / match-existing-patterns intent', () => {
    expect(wantsRepoContext('Build an app that matches the style of my repo')).toBe(true)
    expect(wantsRepoContext('Use my connected GitHub repository as a reference')).toBe(true)
    expect(wantsRepoContext('Extend my codebase with a settings page')).toBe(true)
    expect(wantsRepoContext('Match the existing patterns and conventions')).toBe(true)
    expect(wantsRepoContext('Based on the existing project, add auth')).toBe(true)
    expect(wantsRepoContext('look at the repository and build something consistent')).toBe(true)
  })

  it('"the project" alone (generic spec prose) does NOT trigger — only my/our/existing project does', () => {
    expect(wantsRepoContext('The project should be responsive and fast')).toBe(false)
    expect(wantsRepoContext('extend our project with a dashboard')).toBe(true)
  })
})
