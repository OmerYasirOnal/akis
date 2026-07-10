import { describe, it, expect } from 'vitest'
import { resolveAdminPolicy, isAdminEmail } from '../../src/auth/admin.js'

describe('resolveAdminPolicy (env allowlist)', () => {
  it('NO admin env ⇒ not configured, empty set (byte-identical default)', () => {
    const p = resolveAdminPolicy({})
    expect(p.configured).toBe(false)
    expect(p.emails.size).toBe(0)
  })

  it('AKIS_ADMIN_EMALS: comma-split, trimmed, lowercased', () => {
    const p = resolveAdminPolicy({ AKIS_ADMIN_EMAILS: ' Ada@Akis.dev , bob@akis.dev ,, ' })
    expect(p.configured).toBe(true)
    expect([...p.emails].sort()).toEqual(['ada@akis.dev', 'bob@akis.dev'])
  })

  it('the single-owner (AKIS_OWNER_EMAIL) is ALWAYS an admin, merged with the allowlist', () => {
    const p = resolveAdminPolicy({ AKIS_OWNER_EMAIL: 'Owner@Akis.dev', AKIS_ADMIN_EMAILS: 'ada@akis.dev' })
    expect([...p.emails].sort()).toEqual(['ada@akis.dev', 'owner@akis.dev'])
  })

  it('AKIS_OWNER_EMAIL alone configures the policy', () => {
    const p = resolveAdminPolicy({ AKIS_OWNER_EMAIL: 'owner@akis.dev' })
    expect(p.configured).toBe(true)
    expect(p.emails.has('owner@akis.dev')).toBe(true)
  })
})

describe('isAdminEmail', () => {
  const p = resolveAdminPolicy({ AKIS_ADMIN_EMAILS: 'ada@akis.dev' })
  it('matches case-insensitively', () => {
    expect(isAdminEmail('ADA@AKIS.dev', p)).toBe(true)
    expect(isAdminEmail(' ada@akis.dev ', p)).toBe(true)
  })
  it('rejects a non-admin email', () => {
    expect(isAdminEmail('mallory@akis.dev', p)).toBe(false)
  })
  it('an unconfigured policy is never an admin (guard against accidental all-admin)', () => {
    const none = resolveAdminPolicy({})
    expect(isAdminEmail('ada@akis.dev', none)).toBe(false)
  })
  it('undefined/empty email is never an admin', () => {
    expect(isAdminEmail(undefined, p)).toBe(false)
    expect(isAdminEmail('', p)).toBe(false)
  })
})
