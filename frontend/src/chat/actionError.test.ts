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

  it('falls back to "code: message" for any other ApiError (unchanged behavior)', () => {
    const e = new ApiError(409, 'Session already pushed', 'AlreadyPushedError')
    expect(actionErrorText(e, en)).toBe('AlreadyPushedError: Session already pushed')
  })

  it('stringifies a non-ApiError (unchanged behavior)', () => {
    expect(actionErrorText(new Error('boom'), en)).toBe('Error: boom')
    expect(actionErrorText('plain', en)).toBe('plain')
  })
})
