import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Mock node:child_process so NO real ssh/scp is ever spawned (OFFLINE). The mock records the
// argv and lets each test drive the child's exit. This keeps the suite host-independent and
// guarantees the network/SSH-isolation invariant.
const spawnCalls: { cmd: string; args: string[] }[] = []
let nextExit: { code: number | null; stdout?: string; stderr?: string } = { code: 0 }

vi.mock('node:child_process', () => {
  return {
    spawn: (cmd: string, args: string[]) => {
      spawnCalls.push({ cmd, args })
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      // Resolve on the next tick so the caller can attach listeners first.
      setImmediate(() => {
        if (nextExit.stdout) child.stdout.emit('data', nextExit.stdout)
        if (nextExit.stderr) child.stderr.emit('data', nextExit.stderr)
        child.emit('close', nextExit.code)
      })
      return child
    },
  }
})

const { OpenSshTransport, SshBinaryMissingError } = await import('../../src/publish/SshTransport.js')

const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE_KEY_BYTES_FOR_OPENSSH_TRANSPORT_TEST\n-----END OPENSSH PRIVATE KEY-----'
// SACRED: a test must NEVER write the real ~/.config/akis. Every OpenSshTransport here injects a
// throwaway temp knownHostsDir (cleaned up in afterAll) so the persistent-pin write is sandboxed.
const KH_DIR = mkdtempSync(join(tmpdir(), 'akis-kh-cfg-'))
const CFG = { host: 'oci.example.com', user: 'ubuntu', privateKeyPem: PEM, knownHostsDir: KH_DIR }

afterEach(() => { spawnCalls.length = 0; nextExit = { code: 0 }; vi.clearAllMocks() })
afterAll(() => { rmSync(KH_DIR, { recursive: true, force: true }) })

describe('OpenSshTransport (offline, mocked spawn)', () => {
  it('carries the hardening flags + `--` before user@host, and the key via -i (a FILE, not bytes)', async () => {
    const t = new OpenSshTransport(CFG, async () => true) // ssh "present"
    await t.run("echo hi")
    const call = spawnCalls.find(c => c.cmd === 'ssh')!
    expect(call.args).toContain('-o'); expect(call.args).toContain('BatchMode=yes')
    expect(call.args).toContain('StrictHostKeyChecking=accept-new')
    expect(call.args.some(a => a.startsWith('ConnectTimeout='))).toBe(true)
    // `--` terminates options, then the positional user@host.
    const dd = call.args.indexOf('--')
    expect(dd).toBeGreaterThan(0)
    expect(call.args[dd + 1]).toBe('ubuntu@oci.example.com')
    // The key reaches ssh ONLY via -i <path> — and the value is a FILE PATH, never the PEM bytes.
    const iIdx = call.args.indexOf('-i')
    expect(iIdx).toBeGreaterThanOrEqual(0)
    const keyPath = call.args[iIdx + 1]!
    expect(keyPath).not.toContain('PRIVATE KEY')
    expect(call.args.join(' ')).not.toContain('FAKE_KEY_BYTES')
    await t.close()
  })

  it('writes the temp key 0600 under a 0700 per-run dir, then removes it on close()', async () => {
    const t = new OpenSshTransport(CFG, async () => true)
    await t.run('echo hi')
    const call = spawnCalls.find(c => c.cmd === 'ssh')!
    const keyPath = call.args[call.args.indexOf('-i') + 1]!
    expect(existsSync(keyPath)).toBe(true)
    // 0600 file, 0700 parent dir (mask the type bits).
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    expect(statSync(keyPath.replace(/\/id$/, '')).mode & 0o777).toBe(0o700)
    // The key bytes ARE on disk (transiently) but only in that 0600 file.
    expect(readFileSync(keyPath, 'utf8')).toContain('FAKE_KEY_BYTES')
    await t.close()
    expect(existsSync(keyPath)).toBe(false) // unlinked + dir removed
  })

  it('a missing ssh binary (ENOENT) surfaces a CLEAN typed error, not a 500-worthy throw', async () => {
    const t = new OpenSshTransport(CFG, async () => false) // ssh NOT on PATH
    await expect(t.run('echo hi')).rejects.toBeInstanceOf(SshBinaryMissingError)
    await t.close()
  })

  it('a non-zero exit is reported as a result code (not a throw)', async () => {
    nextExit = { code: 7, stderr: 'boom' }
    const t = new OpenSshTransport(CFG, async () => true)
    const res = await t.run('false')
    expect(res.code).toBe(7)
    expect(res.stderr).toContain('boom')
    await t.close()
  })

  // ── MED-2: the TOFU host-key pin must PERSIST across runs (else accept-new is hollow) ──
  // The known_hosts file must live OUTSIDE the per-run dir, be STABLE across instances for the
  // SAME destination, and NOT be deleted on close() — that is what makes OpenSSH's accept-new
  // record the host key on first connect and REFUSE a later CHANGED key (a swapped key would
  // otherwise be silently re-accepted on every publish with a fresh per-run known_hosts).
  const knownHostsArg = (call: { args: string[] }): string => {
    const opt = call.args.find(a => a.startsWith('UserKnownHostsFile='))!
    return opt.slice('UserKnownHostsFile='.length)
  }

  it('uses a PERSISTENT known_hosts that is stable across instances + survives close() (real TOFU pin)', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'akis-kh-test-'))
    try {
      // First connect: pin path is created, lives under the persistent baseDir (NOT a per-run tmp).
      const t1 = new OpenSshTransport({ ...CFG, knownHostsDir: baseDir }, async () => true)
      await t1.run('echo one')
      const kh1 = knownHostsArg(spawnCalls.find(c => c.cmd === 'ssh')!)
      expect(kh1.startsWith(baseDir)).toBe(true) // persistent dir, not os.tmpdir()/akis-publish-*
      expect(existsSync(kh1)).toBe(true)
      expect(statSync(kh1).mode & 0o777).toBe(0o600) // 0600 file
      // Simulate OpenSSH recording the host key on first connect (the TOFU pin).
      writeFileSync(kh1, 'oci.example.com ssh-ed25519 AAAApinnedkey\n')
      await t1.close()
      // close() removed the per-run KEY dir, but the PIN file must REMAIN (else a changed key
      // is re-accepted next time). This is the crux of the MED-2 fix.
      expect(existsSync(kh1)).toBe(true)
      expect(readFileSync(kh1, 'utf8')).toContain('AAAApinnedkey')

      // Second connect (a brand-new instance, same destination): SAME pin path is reused, and the
      // first-connect entry is intact — so OpenSSH compares against it and REFUSES a changed key.
      spawnCalls.length = 0
      const t2 = new OpenSshTransport({ ...CFG, knownHostsDir: baseDir }, async () => true)
      await t2.run('echo two')
      const kh2 = knownHostsArg(spawnCalls.find(c => c.cmd === 'ssh')!)
      expect(kh2).toBe(kh1) // stable across instances for the same user@host
      expect(readFileSync(kh2, 'utf8')).toContain('AAAApinnedkey') // existing pin NOT truncated
      await t2.close()
      expect(existsSync(kh2)).toBe(true) // still persisted
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  it('a DIFFERENT destination gets a DIFFERENT known_hosts file (per-host pins never collide)', async () => {
    const baseDir = mkdtempSync(join(tmpdir(), 'akis-kh-test-'))
    try {
      const a = new OpenSshTransport({ ...CFG, host: 'host-a.example.com', knownHostsDir: baseDir }, async () => true)
      await a.run('echo a')
      const khA = knownHostsArg(spawnCalls.find(c => c.cmd === 'ssh')!)
      await a.close()
      spawnCalls.length = 0
      const b = new OpenSshTransport({ ...CFG, host: 'host-b.example.com', knownHostsDir: baseDir }, async () => true)
      await b.run('echo b')
      const khB = knownHostsArg(spawnCalls.find(c => c.cmd === 'ssh')!)
      await b.close()
      expect(khA).not.toBe(khB) // distinct destinations → distinct pin files
      expect(khA.startsWith(baseDir)).toBe(true)
      expect(khB.startsWith(baseDir)).toBe(true)
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
