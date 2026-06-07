import { describe, it, expect } from 'vitest'
import { DeterministicValidator } from '../../src/validator/DeterministicValidator.js'
import { languageFor } from '../../src/validator/ValidatorTypes.js'

describe('DeterministicValidator (ported)', () => {
  it('passes clean files', () => {
    const v = new DeterministicValidator()
    const r = v.validate({ files: [{ path: 'index.ts', content: 'export const x = 1\n', language: 'typescript' }] })
    expect(r.passed).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(60)
  })
  it('fails on a security error (eval)', () => {
    const v = new DeterministicValidator()
    const r = v.validate({ files: [{ path: 'bad.ts', content: 'eval("x")\n', language: 'typescript' }] })
    expect(r.passed).toBe(false)
    expect(r.summary.errors).toBeGreaterThanOrEqual(1)
  })

  it('languageFor maps by extension; a generated README (.md) is NOT syntax-checked as code (#46)', () => {
    expect(languageFor('README.md')).toBe('text')
    expect(languageFor('docs/notes.txt')).toBe('text')
    expect(languageFor('src/app.ts')).toBe('typescript')
    expect(languageFor('src/app.jsx')).toBe('javascript')
    expect(languageFor('package.json')).toBe('json')
    expect(languageFor('styles.css')).toBe('css')
    // A README whose prose has an unbalanced brace would be a TS "syntax" error if mislabeled as code.
    const v = new DeterministicValidator()
    const r = v.validate({ files: [{ path: 'README.md', content: '# App\n\nSet `{ "key": value` in config — note the unbalanced brace in prose.\n', language: languageFor('README.md') }] })
    expect(r.issues.filter(i => i.category === 'syntax')).toHaveLength(0)
  })
})
