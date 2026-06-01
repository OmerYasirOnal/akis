import { describe, it, expect } from 'vitest'
import { DeterministicValidator } from '../../src/validator/DeterministicValidator.js'

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
})
