import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as verifierMod from '../../src/verify/verifier.js'
import { resolveVerifier } from '../../src/verify/verifier.js'

/**
 * B2 — gate capability leak closed.
 *
 * Before: `createVerifier(runner)` was EXPORTED, so any in-realm module could import it and
 * wrap a fake-passing runner into a Verifier. Now the only public Verifier surface is
 * `resolveVerifier(spec)`, which builds the runner inside verifier.ts from the trusted
 * TestRunner factories (or relays the DI-owned injected runner). `createVerifier` is no
 * longer importable — a forging import is a compile error (TS2305).
 */
describe('B2: verifier capability surface', () => {
  it('does NOT export createVerifier (the leak is closed)', () => {
    expect((verifierMod as Record<string, unknown>).createVerifier).toBeUndefined()
    expect(typeof resolveVerifier).toBe('function')
  })

  it('source no longer exports createVerifier', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, '../../src/verify/verifier.ts'), 'utf8')
    expect(/export\s+function\s+createVerifier/.test(src)).toBe(false)
    expect(/export\s+function\s+resolveVerifier/.test(src)).toBe(true)
  })

  it('the gate still enforces a real ≥1-test pass (fail-closed minting unchanged)', async () => {
    const files = [{ filePath: 'a.ts', content: 'x' }]
    // A genuine passing run mints a token bound to the tested files.
    const ok = await resolveVerifier({ kind: 'mock', cfg: { testsRun: 2, passed: true } }).verify('s1', files)
    expect(ok).not.toBeNull()
    expect(ok?.testsRun).toBe(2)
    // A 0-test run mints NOTHING (no false green), even if marked passed.
    expect(await resolveVerifier({ kind: 'mock', cfg: { testsRun: 0, passed: true } }).verify('s1', files)).toBeNull()
    // A failing run mints nothing.
    expect(await resolveVerifier({ kind: 'mock', cfg: { testsRun: 3, passed: false } }).verify('s1', files)).toBeNull()
    // Fail-closed default (no cfg → 0 tests / not passed) mints nothing.
    expect(await resolveVerifier({ kind: 'mock' }).verify('s1', files)).toBeNull()
  })
})
