import { describe, it, expect } from 'vitest'
import { sessionIdFromSearch } from './sessionParam.js'

describe('sessionIdFromSearch', () => {
  it('reads the ?s= session id', () => {
    expect(sessionIdFromSearch('?s=abc123')).toBe('abc123')
    expect(sessionIdFromSearch('?foo=1&s=xyz&bar=2')).toBe('xyz')
  })
  it('returns undefined when absent or empty', () => {
    expect(sessionIdFromSearch('')).toBeUndefined()
    expect(sessionIdFromSearch('?foo=1')).toBeUndefined()
    expect(sessionIdFromSearch('?s=')).toBeUndefined()
  })
  it('trims and url-decodes the value', () => {
    expect(sessionIdFromSearch('?s=%20s1%20')).toBe('s1')
    expect(sessionIdFromSearch('?s=s%2D1')).toBe('s-1')
  })
  it('tolerates a leading-no-? search string', () => {
    expect(sessionIdFromSearch('s=plain')).toBe('plain')
  })
})
