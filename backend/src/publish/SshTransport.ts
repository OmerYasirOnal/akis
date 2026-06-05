import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, closeSync, openSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * The SSH transport seam — the publish counterpart to RealGitHubAdapter's injected `fetch?`.
 * Real OpenSSH-spawn in prod (OpenSshTransport); a FakeSshTransport (OFFLINE) in tests. A future
 * PULL-based transport (architecture B, the GitHub-channel delivery) could satisfy the SAME seam
 * without touching the route/store/Publisher.
 *
 * SECURITY CONTRACT (enforced by the implementation + asserted by the tests):
 *  - NO secret is EVER an argv element (argv is world-visible via `ps -ef`/`/proc/<pid>/cmdline`).
 *    The private key reaches OpenSSH ONLY via `-i <0600-tempfile>`; any app-level secret must be
 *    written to a remote file over the channel, never echoed on a command line.
 *  - The decrypted PEM lives in a 0600 file under a 0700 per-run dir, unlinked in `finally` + an
 *    `process.on('exit')` hook (a crash between create and finally still cleans up).
 */
export interface SshExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface SshRunOpts {
  /** Per-step timeout. On expiry the spawn is killed and the result carries a non-zero code. */
  timeoutMs?: number
}

export interface SshTransport {
  /** Run a remote command. `cmd` is a single remote shell command string (the caller is
   *  responsible for having validated/escaped every interpolated component). */
  run(cmd: string, opts?: SshRunOpts): Promise<SshExecResult>
  /** Upload files to `targetDir` on the remote (paths are relative to targetDir). */
  putFiles(files: { filePath: string; content: string }[], targetDir: string): Promise<void>
  /** Release any resources (temp key dir, connections). Idempotent. */
  close(): Promise<void>
}

export interface SshConfig {
  host: string
  user: string
  /** The PEM-encoded private key — written to a transient 0600 temp file, NEVER an argv element. */
  privateKeyPem: string
  /** OpenSSH ConnectTimeout (seconds, default 10) so a dead host fails fast. */
  connectTimeoutMs?: number
  /** Base dir under which the PERSISTENT per-destination known_hosts file lives (so `accept-new`
   *  genuinely PINS on first connect and REFUSES a later changed key — TOFU). Defaults to
   *  ~/.config/akis/known_hosts (0700). Injectable so tests never touch the real home dir. The
   *  PRIVATE KEY is still written to a per-run temp dir that close() deletes — only known_hosts
   *  must survive across runs. */
  knownHostsDir?: string
}

/** Whether a LOCAL binary resolves on PATH — copied from PreviewRegistry.commandOnPath. Spawns
 *  `<cmd> --version` (no shell): a spawn ENOENT means it isn't installed. Injectable so the
 *  transport stays testable without a real ssh on the test runner's PATH. */
export type CommandOnPath = (cmd: string) => Promise<boolean>

const defaultCommandOnPath: CommandOnPath = cmd => new Promise(res => {
  const p = spawn(cmd, ['-V'], { stdio: 'ignore' }) // ssh prints its version to stderr on -V
  p.on('error', () => res(false)) // ENOENT etc. → not on PATH
  p.on('close', () => res(true))  // ran (exit code irrelevant for presence)
})

export class SshBinaryMissingError extends Error {
  constructor(cmd: string) { super(`${cmd} not found on the AKIS host PATH — install openssh-client`); this.name = 'SshBinaryMissingError' }
}

/**
 * OpenSSH-backed transport: spawns the system `ssh`/`scp` binaries (no native `ssh2` dep — the
 * repo's deliberate no-native-deps posture). The decrypted key is written to a 0600 file under a
 * 0700 per-run dir in os.tmpdir(); both are removed in close() AND by a process-exit hook.
 *
 * Hardening flags on every connect:
 *  - `-o BatchMode=yes`              — never prompt (a hung password prompt would block the worker)
 *  - `-o StrictHostKeyChecking=accept-new` — TOFU: trust an unknown host's key on first use, but
 *                                            REFUSE a CHANGED key (a documented MITM tradeoff)
 *  - `-o ConnectTimeout=<s>`         — a dead host fails fast
 *  - `-o UserKnownHostsFile=<persistentDir>/<hash>` — a PERSISTENT, per-destination known_hosts
 *    (under ~/.config/akis/known_hosts, 0700; the file 0600). It MUST survive across runs so that
 *    accept-new genuinely PINS the host key on the first connect and REFUSES a later CHANGED key —
 *    a per-run temp known_hosts (deleted on close()) re-accepts a swapped key every publish, making
 *    the TOFU pin hollow. The decrypted PRIVATE KEY stays in a per-run temp dir that close() deletes.
 *  - `--` before `<user>@<host>`     — positionals are terminated so a (already-validated) host
 *    can never be reinterpreted as an option (belt-and-suspenders with the host validator)
 */
export class OpenSshTransport implements SshTransport {
  private perRunDir: string | undefined
  private keyPath: string | undefined
  private knownHostsPath: string | undefined
  private exitHook: (() => void) | undefined
  private readonly connectTimeoutS: number

  constructor(
    private readonly cfg: SshConfig,
    private readonly commandOnPath: CommandOnPath = defaultCommandOnPath,
  ) {
    this.connectTimeoutS = Math.max(1, Math.round((cfg.connectTimeoutMs ?? 10_000) / 1000))
  }

  /** Lazily materialize the 0700 dir + 0600 key file on first use. The PATH itself is sensitive
   *  (it is never logged). The exit hook guarantees cleanup even on a crash before close(). The
   *  known_hosts path is resolved to a PERSISTENT per-destination file (NOT the per-run dir) so the
   *  TOFU pin survives across runs — see persistentKnownHostsPath(). */
  private ensureKey(): { keyPath: string; knownHostsPath: string } {
    if (this.keyPath && this.knownHostsPath) return { keyPath: this.keyPath, knownHostsPath: this.knownHostsPath }
    // 1. A 0700 parent dir ONLY the spawning node user can enter — SHIELDS any momentarily-loose
    //    child mode (writeFileSync's mode is umask-masked until the chmod lands; the codebase
    //    always follows a secret write with an explicit chmod — see server.ts:450).
    const dir = mkdtempSync(join(tmpdir(), 'akis-publish-'))
    chmodSync(dir, 0o700)
    this.perRunDir = dir
    const keyPath = join(dir, 'id')
    // 2. Write 0600 then chmod 0600 unconditionally (mode above is umask-masked).
    writeFileSync(keyPath, this.cfg.privateKeyPem, { mode: 0o600 })
    chmodSync(keyPath, 0o600)
    // 3. The known_hosts file PERSISTS across runs (under ~/.config/akis/known_hosts by default),
    //    so accept-new pins the host key on first connect and REFUSES a later changed key. We only
    //    ENSURE the file exists (never truncate it — an existing pin must be preserved).
    const knownHostsPath = this.persistentKnownHostsPath()
    this.keyPath = keyPath
    this.knownHostsPath = knownHostsPath
    // A process-exit hook so a crash between create and close() never leaves the PRIVATE KEY on
    // disk (mirrors PreviewRegistry teardown discipline). It removes ONLY the per-run dir — the
    // persistent known_hosts is deliberately left in place. Removed in close() to avoid leaking hooks.
    this.exitHook = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ } }
    process.on('exit', this.exitHook)
    return { keyPath, knownHostsPath }
  }

  /** Resolve (and ENSURE, never truncate) the PERSISTENT per-destination known_hosts file. The
   *  filename is a stable hash of `<user>@<host>` so the SAME destination always reuses the SAME
   *  pin file across OpenSshTransport instances — that is what makes accept-new a real TOFU pin
   *  (first connect records the key; a later CHANGED key is refused). The dir is 0700, the file
   *  0600. Returns the path; the file is created empty only if it does not already exist. */
  private persistentKnownHostsPath(): string {
    const baseDir = this.cfg.knownHostsDir ?? join(homedir(), '.config', 'akis', 'known_hosts')
    mkdirSync(baseDir, { recursive: true, mode: 0o700 })
    chmodSync(baseDir, 0o700) // mode above is umask-masked; make 0700 unconditional
    const id = createHash('sha256').update(`${this.cfg.user}@${this.cfg.host}`).digest('hex').slice(0, 32)
    const file = join(baseDir, `${id}.known_hosts`)
    // Create-if-absent WITHOUT truncating an existing pin (openSync 'a' is create-or-append; the
    // empty append leaves any existing entries intact). Then chmod 0600 unconditionally.
    if (!existsSync(file)) { closeSync(openSync(file, 'a', 0o600)) }
    chmodSync(file, 0o600)
    return file
  }

  /** Common ssh options. `-i <keyPath>` is the ONLY way the key reaches OpenSSH (a file path,
   *  not the key bytes — argv is world-visible). */
  private sshBaseArgs(keyPath: string, knownHostsPath: string): string[] {
    return [
      '-i', keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHostsPath}`,
      '-o', `ConnectTimeout=${this.connectTimeoutS}`,
    ]
  }

  async run(cmd: string, opts?: SshRunOpts): Promise<SshExecResult> {
    if (!(await this.commandOnPath('ssh'))) throw new SshBinaryMissingError('ssh')
    const { keyPath, knownHostsPath } = this.ensureKey()
    // `--` terminates options so the (already-validated) host can never be read as one.
    const args = [...this.sshBaseArgs(keyPath, knownHostsPath), '--', `${this.cfg.user}@${this.cfg.host}`, cmd]
    return spawnCapture('ssh', args, opts?.timeoutMs)
  }

  async putFiles(files: { filePath: string; content: string }[], targetDir: string): Promise<void> {
    if (!(await this.commandOnPath('scp'))) throw new SshBinaryMissingError('scp')
    const { keyPath, knownHostsPath } = this.ensureKey()
    // Stage the files in a local 0700 dir, preserving their relative paths, then scp -r the whole
    // tree to targetDir. scp argv carries only PATHS (never secrets). The staging dir lives under
    // the per-run 0700 dir so it is cleaned up with close().
    const dir = this.perRunDir!
    const stageRoot = join(dir, 'stage')
    mkdirSync(stageRoot, { recursive: true, mode: 0o700 })
    for (const f of files) {
      // f.filePath is an app-internal relative path (e.g. 'src/index.js'); join keeps it inside
      // stageRoot. We do NOT trust it blindly for the remote — but the REMOTE side receives it via
      // scp -r into targetDir, and targetDir was validated. A '..' in an agent-produced path is
      // contained by writing under stageRoot (a '..' would escape — guard below).
      const rel = f.filePath.replace(/^\.?\//, '')
      if (rel.includes('..')) continue // never stage a traversal path
      const dest = join(stageRoot, rel)
      mkdirSync(join(dest, '..'), { recursive: true })
      writeFileSync(dest, f.content)
    }
    // scp -r stageRoot/* → user@host:targetDir. We scp the CONTENTS (the trailing '/.') so files
    // land directly under targetDir, not under a nested 'stage' dir.
    const args = [
      ...this.sshBaseArgs(keyPath, knownHostsPath),
      '-r', '--', `${stageRoot}/.`, `${this.cfg.user}@${this.cfg.host}:${targetDir}`,
    ]
    const res = await spawnCapture('scp', args)
    if (res.code !== 0) throw new Error(`scp to ${targetDir} failed (code ${res.code})`)
  }

  async close(): Promise<void> {
    if (this.exitHook) { process.removeListener('exit', this.exitHook); this.exitHook = undefined }
    // Remove ONLY the per-run dir (the decrypted PRIVATE KEY + staged files). The PERSISTENT
    // known_hosts pin lives OUTSIDE perRunDir and is deliberately LEFT IN PLACE so a later
    // CHANGED host key is refused on the next publish (a per-run delete would re-accept it).
    if (this.perRunDir) { try { rmSync(this.perRunDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
    this.perRunDir = undefined; this.keyPath = undefined; this.knownHostsPath = undefined
  }
}

/** Spawn a binary and capture stdout/stderr with a bounded buffer + an optional timeout. NO
 *  secret is ever passed as an arg by callers; the captured streams are scrubbed by the Publisher
 *  before they reach any persisted log. */
function spawnCapture(cmd: string, args: string[], timeoutMs?: number): Promise<SshExecResult> {
  return new Promise(res => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const cap = (s: string, add: string): string => (s + add).slice(-8 * 1024) // bound at ~8KB
    child.stdout?.on('data', d => { out = cap(out, String(d)) })
    child.stderr?.on('data', d => { err = cap(err, String(d)) })
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    child.on('error', e => { if (timer) clearTimeout(timer); res({ code: null, stdout: out, stderr: err + String((e as Error).message) }) })
    child.on('close', code => {
      if (timer) clearTimeout(timer)
      res({ code: timedOut ? null : code, stdout: out, stderr: timedOut ? err + '\n[timed out]' : err })
    })
  })
}
