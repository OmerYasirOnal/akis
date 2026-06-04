import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateDevSecret } from '../../src/api/server.js'

describe('loadOrCreateDevSecret (dev-only persisted auth secret)', () => {
  it('creates the secret once (0600) and RETURNS THE SAME VALUE across restarts — no more silent dev logout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'akis-devsecret-'))
    const file = join(dir, 'nested', 'dev-secret')
    try {
      const first = loadOrCreateDevSecret(file)
      expect(first.length).toBeGreaterThanOrEqual(64) // 32 random bytes hex-encoded
      expect(readFileSync(file, 'utf8').trim()).toBe(first)
      // Owner-only: the secret file must never be group/world readable. (POSIX-only —
      // Windows has no mode bits; CI runs Linux, but keep the assertion portable.)
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
      // "Restart": a second call reads the SAME secret back — JWTs stay valid.
      expect(loadOrCreateDevSecret(file)).toBe(first)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('rejects a too-short persisted value and regenerates (a truncated/tampered file never weakens auth)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'akis-devsecret-'))
    const file = join(dir, 'dev-secret')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, 'short', 'utf8')
      const secret = loadOrCreateDevSecret(file)
      expect(secret).not.toBe('short')
      expect(secret.length).toBeGreaterThanOrEqual(64)
      // Boundary (PR #95 review): 32 chars = only 16 random bytes — HALF strength. Full
      // strength is 64 hex chars (32 bytes); anything shorter regenerates.
      writeFileSync(file, 'a'.repeat(32), 'utf8')
      const regen = loadOrCreateDevSecret(file)
      expect(regen).not.toBe('a'.repeat(32))
      expect(regen.length).toBeGreaterThanOrEqual(64)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('degrades to an ephemeral secret when the file is unwritable (read-only FS) instead of crashing', () => {
    // A path that cannot be created (parent is a FILE, not a directory).
    const dir = mkdtempSync(join(tmpdir(), 'akis-devsecret-'))
    const blocker = join(dir, 'blocker')
    try {
      writeFileSync(blocker, 'x', 'utf8')
      const secret = loadOrCreateDevSecret(join(blocker, 'dev-secret'))
      expect(secret.length).toBeGreaterThanOrEqual(64) // still a usable secret
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
