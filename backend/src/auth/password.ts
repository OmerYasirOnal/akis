import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

// promisify infers the 3-arg overload; cast to the options-bearing signature.
const scryptAsync = promisify(scrypt) as (password: string | Buffer, salt: string | Buffer, keylen: number, options: ScryptOptions) => Promise<Buffer>
const N = 16384, R = 8, P = 1, KEYLEN = 64 // ~16 MiB work — interactive-login appropriate

/**
 * Hash a password with scrypt (Node built-in — no bcrypt/argon dependency). Returns a
 * self-describing string `scrypt$N$saltB64url$hashB64url` so params travel with the hash.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const dk = (await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P })) as Buffer
  return `scrypt$${N}$${salt.toString('base64url')}$${dk.toString('base64url')}`
}

/** Constant-time verify against a stored scrypt hash. Returns false on any mismatch
 *  or malformed record (never throws on bad input). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const cost = Number(parts[1])
  if (!Number.isInteger(cost) || cost < 2) return false
  const salt = Buffer.from(parts[2] ?? '', 'base64url')
  const expected = Buffer.from(parts[3] ?? '', 'base64url')
  if (salt.length === 0 || expected.length === 0) return false
  let dk: Buffer
  try { dk = (await scryptAsync(password, salt, expected.length, { N: cost, r: R, p: P })) as Buffer } catch { return false }
  return dk.length === expected.length && timingSafeEqual(dk, expected)
}
