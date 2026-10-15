import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { LocalDirectSandbox, scrubEnv } from '../../src/exec/Sandbox.js'
import { detectAppType } from '../../src/preview/AppDetector.js'
import { materialize, teardown, reclaimWorkspaces } from '../../src/preview/Workspace.js'
import { allocatePort, releasePort } from '../../src/preview/ports.js'
import type { RepoFile } from '../../src/di/MockGitHubAdapter.js'

describe('scrubEnv', () => {
  it('drops AI keys / key-store vars and undefined, keeps the rest', () => {
    const out = scrubEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y', AI_KEY_STORE_PATH: '/p', AI_PROVIDER: 'anthropic', PORT: '3000', GONE: undefined })
    expect(out.PATH).toBe('/bin')
    expect(out.PORT).toBe('3000')
    expect(out.ANTHROPIC_API_KEY).toBeUndefined()
    expect(out.OPENAI_API_KEY).toBeUndefined()
    expect(out.AI_KEY_STORE_PATH).toBeUndefined()
    expect(out.AI_PROVIDER).toBeUndefined() // ^AI_ scrubbed
    expect('GONE' in out).toBe(false)
  })
})

describe('LocalDirectSandbox (real node child)', () => {
  it('runs a command and captures stdout/exit code', async () => {
    const sb = new LocalDirectSandbox()
    const r = await sb.run(process.execPath, ['-e', 'process.stdout.write("hi")'], { cwd: tmpdir() })
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('hi')
    expect(r.timedOut).toBe(false)
  })

  it('scrubs AI keys from the child env (no leak into the run)', async () => {
    process.env.ANTHROPIC_API_KEY = 'super-secret-should-not-leak'
    try {
      const sb = new LocalDirectSandbox()
      const r = await sb.run(process.execPath, ['-e', 'process.stdout.write(process.env.ANTHROPIC_API_KEY ? "LEAK" : "CLEAN")'], { cwd: tmpdir() })
      expect(r.stdout).toBe('CLEAN')
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('kills a runaway process group on timeout', async () => {
    const sb = new LocalDirectSandbox()
    const r = await sb.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), timeoutMs: 250 })
    expect(r.timedOut).toBe(true)
    expect(r.code).not.toBe(0) // killed, not a clean exit
  })

  it('passes explicit env additions through (e.g. PORT)', async () => {
    const sb = new LocalDirectSandbox()
    const r = await sb.run(process.execPath, ['-e', 'process.stdout.write(process.env.PORT ?? "none")'], { cwd: tmpdir(), env: { PORT: '4321' } })
    expect(r.stdout).toBe('4321')
  })
})

describe('detectAppType', () => {
  const f = (filePath: string, content: string): RepoFile => ({ filePath, content })
  it('detects a vite app', () => {
    expect(detectAppType([f('package.json', JSON.stringify({ devDependencies: { vite: '^5' } }))])).toBe('vite')
    expect(detectAppType([f('package.json', JSON.stringify({ scripts: { dev: 'vite' } }))])).toBe('vite')
  })
  it('detects a node service', () => {
    expect(detectAppType([f('package.json', JSON.stringify({ scripts: { start: 'node server.js' } }))])).toBe('node-service')
    expect(detectAppType([f('package.json', JSON.stringify({})), f('server.js', 'x')])).toBe('node-service')
  })
  it('detects a static site', () => {
    expect(detectAppType([f('index.html', '<html></html>')])).toBe('static')
  })
  it('a runnable app that merely LISTS a db dep still previews (vite wins over the db hint)', () => {
    expect(detectAppType([f('package.json', JSON.stringify({ dependencies: { pg: '^8', vite: '^5' } }))])).toBe('vite')
  })
  it('flags PURELY db-infra apps (no runnable surface) as unsupported', () => {
    expect(detectAppType([f('package.json', JSON.stringify({ dependencies: { pg: '^8', prisma: '^5' } }))])).toBe('unsupported')
  })
  it('detects a next app (dep or script)', () => {
    expect(detectAppType([f('package.json', JSON.stringify({ dependencies: { next: '^14' } }))])).toBe('next')
    expect(detectAppType([f('package.json', JSON.stringify({ scripts: { dev: 'next dev' } }))])).toBe('next')
  })
  it('unsupported when nothing recognizable', () => {
    expect(detectAppType([f('readme.md', 'hi')])).toBe('unsupported')
  })
  it('classifies a CLI (bin field, no server-listen evidence) as cli, NOT node-service', () => {
    // A real CLI tool: bin entry, a start script that runs the CLI once, a test script — but
    // NO server-listen code anywhere. Must NOT be booted as a persistent server.
    const files = [
      f('package.json', JSON.stringify({
        name: 'mycli', main: 'dist/cli.js', bin: { mycli: 'dist/cli.js' },
        scripts: { start: 'node dist/cli.js', test: 'vitest run' },
      })),
      f('dist/cli.js', 'const args = process.argv.slice(2); console.log("hello", args)'),
      f('tests/cli.test.ts', 'import { it, expect } from "vitest"; it("works", () => expect(1).toBe(1))'),
    ]
    expect(detectAppType(files)).toBe('cli')
  })
  it('classifies a main+start+test app with no listen/framework as cli (the reproduced bug)', () => {
    const files = [
      f('package.json', JSON.stringify({
        name: 'tool', main: 'dist/index.js',
        scripts: { start: 'node dist/index.js', test: 'vitest run', build: 'tsc' },
      })),
      f('src/index.ts', 'export function run() { return 42 }'),
    ]
    expect(detectAppType(files)).toBe('cli')
  })
  it('a node-service with ACTUAL listen code stays node-service (even with a test script)', () => {
    const files = [
      f('package.json', JSON.stringify({ main: 'server.js', scripts: { start: 'node server.js', test: 'vitest run' } })),
      f('server.js', "const http = require('node:http'); http.createServer((_q,r)=>r.end('ok')).listen(process.env.PORT)"),
    ]
    expect(detectAppType(files)).toBe('node-service')
  })
  it('a node-service with a server FRAMEWORK dep stays node-service (framework is server evidence)', () => {
    const files = [
      f('package.json', JSON.stringify({ main: 'server.js', dependencies: { express: '^4' }, scripts: { start: 'node server.js', test: 'vitest run' } })),
      f('server.js', 'const app = require("express")(); app.get("/", (_q,r)=>r.send("ok")); module.exports = app'),
    ]
    expect(detectAppType(files)).toBe('node-service')
  })
})

let made: string | undefined
afterEach(async () => { if (made) { await teardown(made); made = undefined } })

describe('Workspace', () => {
  it('materializes files (incl. nested) then tears down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akis-ws-'))
    made = await materialize('sess1', [{ filePath: 'index.ts', content: 'export const x = 1' }, { filePath: 'src/app.ts', content: 'app' }], root)
    expect(await readFile(join(made, 'index.ts'), 'utf8')).toBe('export const x = 1')
    expect(await readFile(join(made, 'src/app.ts'), 'utf8')).toBe('app')
    const dir = made
    await teardown(dir); made = undefined
    expect(existsSync(dir)).toBe(false)
  })
  it('rejects path traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akis-ws-'))
    await expect(materialize('s', [{ filePath: '../escape.ts', content: 'x' }], root)).rejects.toThrow(/escapes/)
  })
})

describe('reclaimWorkspaces (startup recovery)', () => {
  it('removes every entry UNDER the root, keeps the root, and never escapes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akis-reclaim-'))
    // A sibling OUTSIDE the root that must survive (proves we never rm outside the guard).
    const outside = await mkdtemp(join(tmpdir(), 'akis-outside-'))
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf8')
    // Two orphaned workspace dirs under the root.
    const w1 = await materialize('sessA', [{ filePath: 'a.ts', content: 'a' }], root)
    const w2 = await materialize('sessB', [{ filePath: 'b.ts', content: 'b' }], root)
    expect(existsSync(w1)).toBe(true); expect(existsSync(w2)).toBe(true)

    await reclaimWorkspaces(root)

    expect(existsSync(w1)).toBe(false)
    expect(existsSync(w2)).toBe(false)
    expect(existsSync(root)).toBe(true)              // the root itself is preserved
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true) // nothing outside touched
    await teardown(root); await teardown(outside)
  })
  it('is a no-op when the root does not exist (fresh boot)', async () => {
    const root = join(tmpdir(), `akis-missing-${Math.random().toString(36).slice(2)}`)
    await expect(reclaimWorkspaces(root)).resolves.toBeUndefined()
  })
  // PR #83 review: ownership sentinel — only entries matching the materialize naming pattern
  // (`<id>-<12hex>`) are reclaimed, so a mis-pointed AKIS_WORKSPACES_DIR (a populated dir / $HOME)
  // can't wipe unrelated files at boot, even though they're inside the configured root.
  it('only reclaims AKIS-created workspaces — unrelated files/dirs inside the root survive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'akis-reclaim-own-'))
    const ws = await materialize('sessX', [{ filePath: 'a.ts', content: 'a' }], root) // AKIS-owned → removed
    await writeFile(join(root, 'important.txt'), 'do not delete', 'utf8')              // unrelated → kept
    await mkdir(join(root, 'my-project'), { recursive: true })
    await writeFile(join(root, 'my-project', 'README.md'), 'mine', 'utf8')             // unrelated dir → kept

    await reclaimWorkspaces(root)

    expect(existsSync(ws)).toBe(false)
    expect(existsSync(join(root, 'important.txt'))).toBe(true)
    expect(existsSync(join(root, 'my-project', 'README.md'))).toBe(true)
    await teardown(root)
  })
})

describe('allocatePort', () => {
  it('returns distinct reserved ports', async () => {
    const a = await allocatePort()
    const b = await allocatePort()
    expect(a).toBeGreaterThan(0)
    expect(a).not.toBe(b)
    releasePort(a); releasePort(b)
  })
})
