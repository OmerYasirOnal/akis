import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PreviewRegistry } from '../../src/preview/PreviewRegistry.js'
import { LocalDirectSandbox } from '../../src/exec/Sandbox.js'
import { materialize } from '../../src/preview/Workspace.js'
import { detectAppType } from '../../src/preview/AppDetector.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

/**
 * Phase G acceptance (plan §3): a GENERATED-STYLE FULL-STACK app — exactly the shape
 * PROTO_SYSTEM rule 3b mandates (node:sqlite via Node's BUILT-IN module, zero npm deps,
 * scrypt-hashed passwords, httpOnly session cookie, /api/* JSON endpoints) — REALLY
 * boots through the PreviewRegistry and round-trips SIGNUP → LOGIN → CRUD over HTTP.
 *
 * This is the "real SaaS MVP" proof: accounts + relational persistence, no database
 * server, no native build (install stays --ignore-scripts-safe).
 */
const FULLSTACK: RepoFile[] = [
  {
    filePath: 'package.json',
    content: JSON.stringify({ name: 'phase-g-acceptance', main: 'server.js' }),
  },
  {
    filePath: 'server.js',
    content: `
const http = require('node:http')
const crypto = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')

const db = new DatabaseSync('app.db')
db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, salt TEXT, hash TEXT)')
db.exec('CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, user_id INTEGER, text TEXT)')
const sessions = new Map() // token -> user id (in-memory session table)

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex')
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const readBody = req => new Promise(r => { let b = ''; req.on('data', d => { b += d }); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })
const userOf = req => {
  const m = /session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')
  return m ? sessions.get(m[1]) : undefined
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/signup' && req.method === 'POST') {
    const { email, password } = await readBody(req)
    if (!email || !password) return json(res, 400, { error: 'email+password required' })
    const salt = crypto.randomBytes(16).toString('hex')
    try { db.prepare('INSERT INTO users (email, salt, hash) VALUES (?, ?, ?)').run(email, salt, hashPw(password, salt)) }
    catch { return json(res, 409, { error: 'email taken' }) }
    return json(res, 201, { ok: true })
  }
  if (req.url === '/api/login' && req.method === 'POST') {
    const { email, password } = await readBody(req)
    const row = db.prepare('SELECT id, salt, hash FROM users WHERE email = ?').get(email)
    if (!row) return json(res, 401, { error: 'invalid credentials' })
    const candidate = Buffer.from(hashPw(password, row.salt), 'hex')
    const stored = Buffer.from(row.hash, 'hex')
    // Equal-length guard FIRST (review #102): a corrupted/odd-length stored hash would make
    // timingSafeEqual THROW (crashing login) instead of failing the credential check.
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return json(res, 401, { error: 'invalid credentials' })
    const token = crypto.randomBytes(16).toString('hex')
    sessions.set(token, row.id)
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=' + token + '; HttpOnly; SameSite=Strict; Path=/' })
    return res.end(JSON.stringify({ ok: true }))
  }
  if (req.url === '/api/items') {
    const uid = userOf(req)
    if (uid === undefined) return json(res, 401, { error: 'login required' })
    if (req.method === 'POST') {
      const { text } = await readBody(req)
      db.prepare('INSERT INTO items (user_id, text) VALUES (?, ?)').run(uid, String(text ?? ''))
      return json(res, 201, { ok: true })
    }
    const items = db.prepare('SELECT text FROM items WHERE user_id = ?').all(uid).map(r => r.text)
    return json(res, 200, { items })
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><body><h1>Phase G</h1></body></html>')
})
server.listen(Number(process.env.PORT ?? 3000), '127.0.0.1')
`.trim(),
  },
]

describe('Phase G: a generated-style FULL-STACK app (node:sqlite + auth) really works', () => {
  let wsDir: string
  let prevEnv: string | undefined
  let registry: PreviewRegistry
  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), 'akis-fullstack-'))
    prevEnv = process.env.AKIS_WORKSPACES_DIR
    process.env.AKIS_WORKSPACES_DIR = wsDir
    registry = new PreviewRegistry({ sandbox: new LocalDirectSandbox() })
  })
  afterEach(async () => {
    await registry.stopAll()
    // Let the SIGKILLed child's file handles (app.db) settle before removing the dir (CI).
    await new Promise(r => setTimeout(r, 100))
    if (prevEnv === undefined) delete process.env.AKIS_WORKSPACES_DIR
    else process.env.AKIS_WORKSPACES_DIR = prevEnv
    rmSync(wsDir, { recursive: true, force: true })
  })

  it('boots, then SIGNUP → LOGIN (cookie) → CRUD round-trips against the real SQLite-backed server', async () => {
    expect(detectAppType(FULLSTACK)).toBe('node-service')
    const dir = await materialize('fs-1', FULLSTACK)
    const entry = await registry.start('fs-1', dir, 'node-service')
    expect(entry.status, entry.reason ?? '').toBe('ready')
    const base = `http://127.0.0.1:${registry.portFor('fs-1')!}`

    // Unauthenticated API access is REJECTED (the grammar's 401 rule).
    expect((await fetch(`${base}/api/items`)).status).toBe(401)

    // SIGNUP → LOGIN: scrypt-hashed credentials verified server-side, session cookie set.
    const signup = await fetch(`${base}/api/signup`, { method: 'POST', body: JSON.stringify({ email: 'ada@x.test', password: 'hunter22' }) })
    expect(signup.status).toBe(201)
    const badLogin = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email: 'ada@x.test', password: 'WRONG' }) })
    expect(badLogin.status).toBe(401)
    const login = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ email: 'ada@x.test', password: 'hunter22' }) })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!
    expect(cookie).toMatch(/session=[a-f0-9]+/)
    expect(cookie).toMatch(/HttpOnly/i)

    // CRUD round-trip through the REAL database: insert a row, read it back.
    const post = await fetch(`${base}/api/items`, { method: 'POST', headers: { cookie }, body: JSON.stringify({ text: 'first row' }) })
    expect(post.status).toBe(201)
    const list = await fetch(`${base}/api/items`, { headers: { cookie } })
    expect(await list.json()).toEqual({ items: ['first row'] })

    await registry.stop('fs-1')
  }, 90_000)
})
