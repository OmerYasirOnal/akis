import { describe, it, expect } from 'vitest'
import { actionErrorText } from './actionError.js'
import { ApiError } from '../api/client.js'
import { STRINGS, type StringKey } from '../i18n/catalog.js'

const en = (k: StringKey): string => STRINGS.en[k] ?? STRINGS.en[k] ?? k
const tr = (k: StringKey): string => STRINGS.tr[k] ?? STRINGS.en[k] ?? k

describe('actionErrorText — localized GitHub delivery failure surfacing', () => {
  it('maps the GitHubDeliveryError code to the localized recovery.push.deliveryFailed key (EN + TR), never the raw provider string', () => {
    // The raw 422 the backend returns: code + the token-free English provider message.
    const e = new ApiError(422, 'github: request to /git/blobs failed (HTTP 404)', 'GitHubDeliveryError')
    expect(actionErrorText(e, en)).toBe(STRINGS.en['recovery.push.deliveryFailed'])
    expect(actionErrorText(e, tr)).toBe(STRINGS.tr['recovery.push.deliveryFailed'])
    // crucially: the raw English provider string is NOT leaked to the user
    expect(actionErrorText(e, en)).not.toContain('/git/blobs')
    expect(actionErrorText(e, tr)).not.toContain('/git/blobs')
  })

  it('a 429 delivery failure gets the DISTINCT rate-limited copy (transient — destination is fine), EN + TR', () => {
    const e = new ApiError(429, 'github: rate limited or forbidden (HTTP 429)', 'GitHubDeliveryError')
    expect(actionErrorText(e, en)).toBe(STRINGS.en['recovery.push.rateLimited'])
    expect(actionErrorText(e, tr)).toBe(STRINGS.tr['recovery.push.rateLimited'])
    // the misleading "check that the repository exists" guidance must NOT appear for a rate-limit
    expect(actionErrorText(e, en)).not.toContain('repository exists')
  })

  it('maps the NoGitHubDestinationError code (a 409) to the localized "connect GitHub" message (EN + TR), never the raw string', () => {
    // The backend refuses an unconnected real-mode push with this stable code instead of a fake
    // mock success. The FE must guide the user to Settings → GitHub, not show the raw message.
    const e = new ApiError(409, 'No GitHub delivery destination — connect a GitHub account and target repo in Settings', 'NoGitHubDestinationError')
    expect(actionErrorText(e, en)).toBe(STRINGS.en['recovery.push.notConnected'])
    expect(actionErrorText(e, tr)).toBe(STRINGS.tr['recovery.push.notConnected'])
  })

  it('falls back to "code: message" for any other ApiError (unchanged behavior)', () => {
    const e = new ApiError(409, 'Session already pushed', 'AlreadyPushedError')
    expect(actionErrorText(e, en)).toBe('AlreadyPushedError: Session already pushed')
  })

  it('stringifies a non-ApiError (unchanged behavior)', () => {
    expect(actionErrorText(new Error('boom'), en)).toBe('Error: boom')
    expect(actionErrorText('plain', en)).toBe('plain')
  })
})

// Guard the push-recovery copy (incl. the new no-destination keys) — a one-locale add must fail here.
describe('recovery.push.* i18n parity', () => {
  const keys = (loc: 'en' | 'tr'): string[] => Object.keys(STRINGS[loc]).filter(k => k.startsWith('recovery.push.')).sort()
  it('every EN recovery.push.* key exists in TR and vice-versa', () => {
    expect(keys('en')).toEqual(keys('tr'))
  })
  it('the new no-destination keys are present + non-empty in BOTH locales', () => {
    for (const loc of ['en', 'tr'] as const) {
      for (const k of ['recovery.push.notConnected', 'recovery.push.connectCta'] as const) {
        expect(STRINGS[loc][k], `${loc}:${k}`).toBeTruthy()
      }
    }
  })
})
