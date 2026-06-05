import { describe, it, expect } from 'vitest'
import { publish, type PublishInput } from '../../src/publish/Publisher.js'
import { FakeSshTransport, type FakeCommandRule } from '../../src/publish/FakeSshTransport.js'

const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE_PUBLISHER_TEST_KEY_SECRET_BYTES\n-----END OPENSSH PRIVATE KEY-----'
const PROFILE = { host: 'oci.example.com', sshUser: 'ubuntu', sshPrivateKey: KEY, targetDir: '/home/ubuntu/app', appPort: 8080 }

const STATIC_FILES = [{ filePath: 'index.html', content: '<h1>hi</h1>' }]
// The verified fullstack shape: a server entry, NO deps, NO lockfile, a RELATIVE db path.
const FULLSTACK_FILES = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'app', main: 'server.js' }) },
  { filePath: 'server.js', content: "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync('app.db');" },
]
const NODE_WITH_DEPS = [
  { filePath: 'package.json', content: JSON.stringify({ name: 'app', main: 'server.js', dependencies: { express: '^4' } }) },
  { filePath: 'server.js', content: "require('express')()" },
]

/** Build a publish input wired to a fresh FakeSshTransport (captured for assertions). */
function setup(files: PublishInput['files'], rules: FakeCommandRule[] = [], extra: Partial<PublishInput> = {}) {
  const fake = new FakeSshTransport([
    // Override rules win (first match): a test prepends e.g. a non-writable probe or a missing node.
    ...rules,
    // Default: node + npm present, target dir writable.
    { match: 'node --version', stdout: 'v22.0.0' },
    { match: 'command -v npm', stdout: '__NPM__' },
    { match: '.akis-write-probe', stdout: '__WRITABLE__' },
  ])
  const input: PublishInput = {
    files,
    profile: PROFILE,
    transportFactory: () => fake,
    now: () => '2026-06-05T00:00:00.000Z',
    ...extra,
  }
  return { fake, input }
}

describe('Publisher (FakeSshTransport, offline)', () => {
  it('static: uploads index.html + static-serve.mjs and starts it bound to 0.0.0.0', async () => {
    const { fake, input } = setup(STATIC_FILES)
    const rec = await publish(input)
    expect(rec.ok).toBe(true)
    expect(rec.appType).toBe('static')
    // The vendored server is shipped + started with the port, binding 0.0.0.0.
    const allFiles = fake.puts.flatMap(p => p.files.map(f => f.filePath))
    expect(allFiles).toContain('static-serve.mjs')
    expect(allFiles).toContain('index.html')
    const serveContent = fake.puts.flatMap(p => p.files).find(f => f.filePath === 'static-serve.mjs')!.content
    expect(serveContent).toContain("'0.0.0.0'")
    expect(fake.commands.some(c => c.includes('node static-serve.mjs 8080'))).toBe(true)
    expect(fake.closed).toBe(true)
  })

  it('node-service WITH deps: runs `npm install --omit=dev --ignore-scripts` (NOT npm ci)', async () => {
    const { fake, input } = setup(NODE_WITH_DEPS)
    const rec = await publish(input)
    expect(rec.ok).toBe(true)
    expect(rec.appType).toBe('node-service')
    expect(fake.commands.some(c => c.includes('npm install --omit=dev --ignore-scripts'))).toBe(true)
    expect(fake.commands.some(c => c.includes('npm ci'))).toBe(false)
  })

  it('node-service with NO deps (the verified fullstack shape): SKIPS install entirely', async () => {
    const { fake, input } = setup(FULLSTACK_FILES)
    const rec = await publish(input)
    expect(rec.ok).toBe(true)
    expect(fake.commands.some(c => c.includes('npm install'))).toBe(false)
    expect(fake.commands.some(c => c.includes('npm ci'))).toBe(false)
  })

  it("generated run.sh `cd`s into targetDir BEFORE `node .` and the until-loop has a sleep", async () => {
    const { fake, input } = setup(FULLSTACK_FILES)
    await publish(input)
    const runSh = fake.puts.flatMap(p => p.files).find(f => f.filePath === 'run.sh')!.content
    const cdIdx = runSh.indexOf('cd "/home/ubuntu/app"')
    const nodeIdx = runSh.indexOf('node .')
    expect(cdIdx).toBeGreaterThanOrEqual(0)
    expect(nodeIdx).toBeGreaterThan(cdIdx) // cd FIRST, then node .
    expect(runSh).toContain('sleep 2') // no tight-spin on an instantly-crashing app
    expect(runSh).toContain('HOST=0.0.0.0')
  })

  it('RE-PUBLISH kills the prior app/run pids BEFORE the new start (idempotent)', async () => {
    const { fake, input } = setup(FULLSTACK_FILES)
    await publish(input)
    const killIdx = fake.commands.findIndex(c => c.includes('app.pid') && c.includes('kill'))
    const startIdx = fake.commands.findIndex(c => c.includes('bash run.sh'))
    expect(killIdx).toBeGreaterThanOrEqual(0)
    expect(startIdx).toBeGreaterThan(killIdx) // stop-before-start ordering
  })

  it('remote node MISSING → ok:false with an honest reason, status untouched', async () => {
    const { input } = setup(FULLSTACK_FILES, [{ match: 'node --version', stdout: '__NO_NODE__' }])
    const rec = await publish(input)
    expect(rec.ok).toBe(false)
    expect(rec.logTail.join(' ')).toContain('node not found on the instance')
  })

  it('targetDir not writable (EACCES) → ok:false with an honest reason', async () => {
    const { input } = setup(FULLSTACK_FILES, [{ match: '.akis-write-probe', stdout: '__NOWRITE__' }])
    const rec = await publish(input)
    expect(rec.ok).toBe(false)
    expect(rec.logTail.join(' ')).toContain('not writable')
  })

  it('a failing npm install → ok:false + a bounded scrubbed logTail (not a throw)', async () => {
    const { input } = setup(NODE_WITH_DEPS, [{ match: 'npm install', code: 1, stdout: 'ERESOLVE could not resolve' }])
    const rec = await publish(input)
    expect(rec.ok).toBe(false)
    expect(rec.logTail.join(' ')).toContain('npm install failed')
  })

  it('a SLOW transport beyond the deadline → ok:false "deadline" reason, RETURNS (no hang)', async () => {
    // A node check that delays 200ms; deadline is 50ms → the step's effective timeout fires.
    const { input } = setup(FULLSTACK_FILES, [{ match: 'node --version', delayMs: 200, stdout: 'v22' }], { deadlineMs: 50, stepTimeoutMs: 50 })
    const rec = await publish(input)
    expect(rec.ok).toBe(false)
    // Either the step timed out or the deadline was exceeded — both are honest non-hangs.
    expect(rec.logTail.join(' ')).toMatch(/timed out|deadline/)
  })

  it('URL probe failing → reachable:false but ok reflects DEPLOY success (not reachability)', async () => {
    const { input } = setup(STATIC_FILES, [], { urlProbe: async () => false })
    const rec = await publish(input)
    expect(rec.ok).toBe(true)
    expect(rec.reachable).toBe(false)
    expect(rec.logTail.join(' ')).toContain('open the inbound port')
  })

  it('URL probe succeeding → reachable:true', async () => {
    const { input } = setup(STATIC_FILES, [], { urlProbe: async () => true })
    const rec = await publish(input)
    expect(rec.ok).toBe(true)
    expect(rec.reachable).toBe(true)
  })

  it('SECRET-LEAK cornerstone: the key appears in NO command, NO file, NO logTail, NO record', async () => {
    const { fake, input } = setup(FULLSTACK_FILES, [{ match: 'npm install', code: 1, stdout: KEY }], { urlProbe: async () => false })
    const rec = await publish(input)
    // Not in any recorded SSH command or staged file.
    fake.assertNoLeak('FAKE_PUBLISHER_TEST_KEY_SECRET_BYTES')
    // Not in the logTail (even though the failing command's stdout literally WAS the key — scrubbed).
    expect(rec.logTail.join('\n')).not.toContain('FAKE_PUBLISHER_TEST_KEY_SECRET_BYTES')
    expect(rec.logTail.join('\n')).not.toContain('BEGIN OPENSSH PRIVATE KEY')
    // Not anywhere in the returned record.
    expect(JSON.stringify(rec)).not.toContain('FAKE_PUBLISHER_TEST_KEY_SECRET_BYTES')
  })

  it('unsupported app → ok:false, code:Unsupported in the log', async () => {
    const { input } = setup([{ filePath: 'schema.prisma', content: 'datasource db {}' }])
    const rec = await publish(input)
    expect(rec.ok).toBe(false)
    expect(rec.appType).toBe('unsupported')
    expect(rec.logTail.join(' ')).toContain('Unsupported')
  })

  it('url defaults to http://host:appPort, or the publicUrl override', async () => {
    const a = setup(STATIC_FILES)
    expect((await publish(a.input)).url).toBe('http://oci.example.com:8080')
    const b = setup(STATIC_FILES, [], { profile: { ...PROFILE, publicUrl: 'https://app.example.com' } })
    expect((await publish(b.input)).url).toBe('https://app.example.com')
  })
})
