import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFile } from '../../src/env/loadEnvFile.js'

const tmp = mkdtempSync(join(tmpdir(), 'akis-env-'))
const write = (body: string): string => { const p = join(tmp, `e${Math.floor(performance.now() * 1e6) % 1e9}`); writeFileSync(p, body); return p }

describe('loadEnvFile — BYO dotenv loader', () => {
  afterEach(() => { /* env mutated on the passed object only */ })

  it('parses KEY=value, strips quotes, ignores comments/blanks, handles export', () => {
    const env: NodeJS.ProcessEnv = {}
    const file = write(['# a comment', '', 'AI_PROVIDER=anthropic', 'AI_API_KEY="sk-ant-xyz"', "AI_MODEL='claude-opus-4-8'", 'export PORT=8080'].join('\n'))
    const set = loadEnvFile(file, env)
    expect(env.AI_PROVIDER).toBe('anthropic')
    expect(env.AI_API_KEY).toBe('sk-ant-xyz')      // quotes stripped
    expect(env.AI_MODEL).toBe('claude-opus-4-8')   // single-quotes stripped
    expect(env.PORT).toBe('8080')                  // `export ` honored
    expect(set).toContain('AI_PROVIDER')
  })

  it('does NOT override an already-set env var (explicit env wins)', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' }
    const file = write('NODE_ENV=production\nAI_PROVIDER=openai')
    loadEnvFile(file, env)
    expect(env.NODE_ENV).toBe('development') // not clobbered
    expect(env.AI_PROVIDER).toBe('openai')
  })

  it('strips an unquoted trailing inline comment (dotenv-standard)', () => {
    const env: NodeJS.ProcessEnv = {}
    const file = write(['AI_MODEL=claude-opus # default', 'BARE=value #c', 'NOSPACE=v', 'EMPTY= # only a comment'].join('\n'))
    loadEnvFile(file, env)
    expect(env.AI_MODEL).toBe('claude-opus') // trailing ` # default` stripped, value re-trimmed
    expect(env.BARE).toBe('value')
    expect(env.NOSPACE).toBe('v')
    expect(env.EMPTY).toBe('')               // comment-only value collapses to empty
  })

  it('keeps `#` intact inside quoted values (it can be a legitimate secret/URL char)', () => {
    const env: NodeJS.ProcessEnv = {}
    const file = write(['SECRET="a#b"', "FRAG='http://h/p#frag'", 'QUOTED="v" # trailing', "HASHVAL=a#b"].join('\n'))
    loadEnvFile(file, env)
    expect(env.SECRET).toBe('a#b')                 // quoted: `#` preserved, quotes stripped
    expect(env.FRAG).toBe('http://h/p#frag')       // quoted: fragment preserved
    expect(env.QUOTED).toBe('v')                   // quoted value, trailing comment after close-quote stripped
    expect(env.HASHVAL).toBe('a#b')                // unquoted `#` with no preceding space is part of the value
  })

  it('tolerates values a shell source would choke on (commas, URLs, spaces)', () => {
    const env: NodeJS.ProcessEnv = {}
    const file = write('DATABASE_URL=postgres://u:p@h:5432/db?x=1\nCORS=http://a,http://b\nNOTE=hello world')
    loadEnvFile(file, env)
    expect(env.DATABASE_URL).toBe('postgres://u:p@h:5432/db?x=1')
    expect(env.CORS).toBe('http://a,http://b')
    expect(env.NOTE).toBe('hello world')
  })

  it('returns [] for a missing file or no path', () => {
    expect(loadEnvFile(join(tmp, 'nope'), {})).toEqual([])
    expect(loadEnvFile(undefined, {})).toEqual([])
  })

  it('reads the path from env.AKIS_ENV_FILE when no arg is given', () => {
    const file = write('AI_PROVIDER=google')
    const env: NodeJS.ProcessEnv = { AKIS_ENV_FILE: file }
    loadEnvFile(undefined, env)
    expect(env.AI_PROVIDER).toBe('google')
  })

  it('preserves a quoted value that itself contains quotes (no first-quote truncation)', () => {
    const env: NodeJS.ProcessEnv = {}
    const file = write(['DJSON="{"a":1}"', "SJSON='{\"a\":1}'", 'NESTED="say "hi""'].join('\n'))
    loadEnvFile(file, env)
    expect(env.DJSON).toBe('{"a":1}')   // double-quoted JSON: inner quotes kept (was truncated to `{`)
    expect(env.SJSON).toBe('{"a":1}')   // single-quoted JSON
    expect(env.NESTED).toBe('say "hi"') // inner double-quotes preserved (was `say `)
  })

  it('does not silently drop trailing content after a close-quote (malformed → raw)', () => {
    const env: NodeJS.ProcessEnv = {}
    const file = write(['TRAIL="abc"def', 'OPEN="oops # x'].join('\n'))
    loadEnvFile(file, env)
    expect(env.TRAIL).toBe('"abc"def')  // not a clean enclosing pair → kept raw (was silently `abc`)
    expect(env.OPEN).toBe('"oops')      // unbalanced open quote → unquoted fallback strips the inline comment
  })
})

process.on('exit', () => { try { rmSync(tmp, { recursive: true, force: true }) } catch { /* noop */ } })
