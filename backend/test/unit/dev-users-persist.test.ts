import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JsonFileUserStore } from '../../src/auth/JsonFileUserStore.js'

const tmpFile = (): { dir: string; file: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'akis-devusers-'))
  return { dir, file: join(dir, 'nested', 'dev-users.json') }
}

describe('JsonFileUserStore (dev account persistence)', () => {
  it('accounts SURVIVE a restart: a new instance over the same file finds the user (the "my signups disappear" fix)', async () => {
    const { dir, file } = tmpFile()
    try {
      const a = new JsonFileUserStore(file)
      const created = await a.create({ name: 'Ada', email: 'Ada@Example.com', passwordHash: 'scrypt$hash' })
      // "Restart": a fresh instance hydrates from the file.
      const b = new JsonFileUserStore(file)
      const found = await b.findByEmail('ada@example.com')
      expect(found).toMatchObject({ id: created.id, email: 'ada@example.com', passwordHash: 'scrypt$hash' })
      expect(await b.findById(created.id)).toBeDefined()
      // 0600 like the dev secret — never group/world readable (POSIX; CI runs Linux).
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('mutations persist: password + name updates and OAuth upserts survive the restart', async () => {
    const { dir, file } = tmpFile()
    try {
      const a = new JsonFileUserStore(file)
      const u = await a.create({ name: 'Ada', email: 'a@x.test', passwordHash: 'h1' })
      await a.updatePassword(u.id, 'h2')
      await a.updateName(u.id, 'Ada L')
      const oauth = await a.upsertOAuth({ externalId: 'gh:1', email: 'gh@x.test', name: 'GH' })
      const b = new JsonFileUserStore(file)
      expect((await b.findById(u.id))!).toMatchObject({ passwordHash: 'h2', name: 'Ada L' })
      // The OAuth identity round-trips INCLUDING the externalId index (upsert finds it again).
      expect((await b.upsertOAuth({ externalId: 'gh:1', email: 'other@x.test', name: 'x' })).id).toBe(oauth.id)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a corrupted or hand-edited file never crashes the boot — bad rows are dropped, valid ones kept', async () => {
    const { dir, file } = tmpFile()
    try {
      const a = new JsonFileUserStore(file)
      await a.create({ name: 'Keep', email: 'keep@x.test', passwordHash: 'h' })
      // Corrupt the file: inject junk rows around the valid one.
      const rows = JSON.parse(readFileSync(file, 'utf8')) as unknown[]
      writeFileSync(file, JSON.stringify([null, 42, { id: 1 }, ...rows, 'junk']), 'utf8')
      const b = new JsonFileUserStore(file)
      expect(await b.findByEmail('keep@x.test')).toBeDefined()
      // …and full garbage starts empty instead of throwing.
      writeFileSync(file, 'not json', 'utf8')
      const c = new JsonFileUserStore(file)
      expect(await c.findByEmail('keep@x.test')).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('an unwritable file degrades to in-memory (warn, no crash) — requests still succeed', async () => {
    const { dir, file } = tmpFile()
    try {
      writeFileSync(join(dir, 'blocker'), 'x', 'utf8')
      const store = new JsonFileUserStore(join(dir, 'blocker', 'dev-users.json'))
      const u = await store.create({ name: 'Mem', email: 'mem@x.test', passwordHash: 'h' })
      expect(u.id).toBeTruthy()
      expect(await store.findByEmail('mem@x.test')).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
