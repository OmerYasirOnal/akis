import { describe, it, expect } from 'vitest'
import { resolveAdminPolicy, isAdminUser } from '../../src/auth/admin.js'

describe('resolveAdminPolicy (env allowlist)', () => {
  it('NO admin env ⇒ not configured, empty set (byte-identical default)', () => {
    const p = resolveAdminPolicy({})
    expect(p.configured).toBe(false)
    expect(p.emails.size).toBe(0)
  })

  it('AKIS_ADMIN_EMAILS: comma-split, trimmed, lowercased', () => {
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

describe('isAdminUser — allowlisted AND provider-verified (OAuth-bound)', () => {
  const p = resolveAdminPolicy({ AKIS_ADMIN_EMAILS: 'ada@akis.dev' })
  const oauth = (email: string) => ({ email, externalId: `google:${email}` }) // provider-verified
  const password = (email: string) => ({ email }) // no externalId → unverified email

  it('an OAuth-bound allowlisted email IS an admin (case-insensitive)', () => {
    expect(isAdminUser(oauth('ada@akis.dev'), p)).toBe(true)
    expect(isAdminUser(oauth('ADA@AKIS.dev'), p)).toBe(true)
  })

  it('SECURITY: a PASSWORD account (no externalId) is NEVER an admin even if the email is allowlisted', () => {
    // Closes the pre-registration escalation: a password signup verifies email format, not ownership.
    expect(isAdminUser(password('ada@akis.dev'), p)).toBe(false)
  })

  it('an OAuth-bound NON-allowlisted email is not an admin', () => {
    expect(isAdminUser(oauth('mallory@akis.dev'), p)).toBe(false)
  })

  it('an unconfigured policy is never an admin (guard against accidental all-admin)', () => {
    const none = resolveAdminPolicy({})
    expect(isAdminUser(oauth('ada@akis.dev'), none)).toBe(false)
  })

  it('undefined user / undefined-or-empty email is never an admin', () => {
    expect(isAdminUser(undefined, p)).toBe(false)
    expect(isAdminUser({ email: '', externalId: 'google:x' }, p)).toBe(false)
    expect(isAdminUser({ externalId: 'google:x' }, p)).toBe(false)
  })
})
