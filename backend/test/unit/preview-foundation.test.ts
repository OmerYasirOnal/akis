import { describe, it, expect, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { LocalDirectSandbox, scrubEnv } from '../../src/exec/Sandbox.js'
import { detectAppType } from '../../src/preview/AppDetector.js'
import { materialize, teardown } from '../../src/preview/Workspace.js'
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
  it('flags db-needing apps as unsupported', () => {
    expect(detectAppType([f('package.json', JSON.stringify({ dependencies: { pg: '^8', vite: '^5' } }))])).toBe('unsupported')
  })
  it('unsupported when nothing recognizable', () => {
    expect(detectAppType([f('readme.md', 'hi')])).toBe('unsupported')
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

describe('allocatePort', () => {
  it('returns distinct reserved ports', async () => {
    const a = await allocatePort()
    const b = await allocatePort()
    expect(a).toBeGreaterThan(0)
    expect(a).not.toBe(b)
    releasePort(a); releasePort(b)
  })
})
