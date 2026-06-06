import { describe, it, expect } from 'vitest'
import { toJson } from '../../src/store/PgSessionStore.js'

/**
 * REGRESSION (caught LIVE): node-pg serializes a JS object as json for a jsonb column but a JS
 * ARRAY as a Postgres array literal `{…}` — invalid for jsonb ("invalid input syntax for type
 * json"). SessionState.chat is the first jsonb ARRAY column and silently failed to persist. toJson
 * must hand pg an explicit JSON STRING for every non-null value (arrays AND objects), so the jsonb
 * write is always valid. The store-parity test missed this because its fake SqlClient does not
 * replicate pg's array-vs-json parameter handling.
 */
describe('toJson — jsonb-safe serialization (the chat-array persistence fix)', () => {
  it('stringifies ARRAYS (the chat case) — never hands pg a raw JS array', () => {
    const chat = [{ role: 'user', content: 'hi', at: '2026-06-06T00:00:00.000Z' }]
    const out = toJson(chat)
    expect(typeof out).toBe('string')
    expect(JSON.parse(out as string)).toEqual(chat)
  })
  it('stringifies OBJECTS too (behaviour-preserving for spec/code/passport/publish)', () => {
    expect(typeof toJson({ a: 1 })).toBe('string')
    expect(JSON.parse(toJson({ a: 1 }) as string)).toEqual({ a: 1 })
  })
  it('null/undefined map to null (absent column)', () => {
    expect(toJson(null)).toBeNull()
    expect(toJson(undefined)).toBeNull()
  })
})
