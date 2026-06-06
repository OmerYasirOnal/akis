import type { SshTransport, SshExecResult, SshRunOpts, PutFilesResult } from './SshTransport.js'

/** A programmable response for a remote command (matched by a substring of the command). */
export interface FakeCommandRule {
  /** Substring the remote command must contain for this rule to apply. */
  match: string
  code?: number
  stdout?: string
  stderr?: string
  /** Artificial delay (ms) — drives the deadline/timeout test. The fake resolves after this. */
  delayMs?: number
}

/**
 * OFFLINE test double for SshTransport — records EVERY remote command + EVERY putFiles payload,
 * so a test can assert ordering (kill-before-start), content (the generated run.sh `cd`s first),
 * and — the cornerstone — that NO recorded command or file content carries a secret substring.
 *
 * Programmable per-command exit/stdout/stderr/delay via rules (first matching rule wins); an
 * unmatched command defaults to code 0 (success). NO network, NO real SSH, NO disk.
 *
 * NOTE: this fake records the RAW command the Publisher passes (it does NOT apply the login-shell
 * `bash -lc` wrap — that is an OpenSshTransport concern, asserted in openSshTransport.test.ts). So
 * the Publisher tests here assert on the plain command strings the Publisher builds, while the
 * transport test pins the wrap. Rule `match` substrings therefore match the unwrapped command.
 */
export class FakeSshTransport implements SshTransport {
  /** Every remote command, in call order. */
  readonly commands: string[] = []
  /** Every putFiles call's payload, in call order (the timeoutMs the Publisher threaded in too). */
  readonly puts: { files: { filePath: string; content: string }[]; targetDir: string; timeoutMs?: number }[] = []
  closed = false
  /** When set, putFiles waits this long; if it exceeds the threaded timeoutMs it THROWS the same
   *  honest "upload … timed out" error the real transport's kill-timer path throws. Drives the
   *  upload-deadline test without a network. */
  putFilesDelayMs = 0

  constructor(private readonly rules: FakeCommandRule[] = []) {}

  async run(cmd: string, opts?: SshRunOpts): Promise<SshExecResult> {
    this.commands.push(cmd)
    const rule = this.rules.find(r => cmd.includes(r.match))
    if (rule?.delayMs && rule.delayMs > 0) {
      // Honor the caller's per-step timeout so the deadline test sees a real timeout, not a hang.
      const timeout = opts?.timeoutMs ?? Infinity
      const waited = Math.min(rule.delayMs, timeout)
      await new Promise(res => setTimeout(res, waited))
      if (rule.delayMs > timeout) return { code: null, stdout: '', stderr: '[timed out]' }
    }
    return { code: rule?.code ?? 0, stdout: rule?.stdout ?? '', stderr: rule?.stderr ?? '' }
  }

  async putFiles(files: { filePath: string; content: string }[], targetDir: string, timeoutMs?: number): Promise<PutFilesResult> {
    this.puts.push({ files: files.map(f => ({ ...f })), targetDir, ...(timeoutMs !== undefined ? { timeoutMs } : {}) })
    if (this.putFilesDelayMs > 0) {
      // Mirror spawnCapture's kill-timer semantics: wait, but never longer than the threaded
      // deadline; if the (simulated) transfer would outlast it, throw the honest timeout error.
      const cap = timeoutMs && timeoutMs > 0 ? timeoutMs : Infinity
      await new Promise(res => setTimeout(res, Math.min(this.putFilesDelayMs, cap)))
      if (this.putFilesDelayMs > cap) throw new Error(`upload to ${targetDir} timed out`)
    }
    // Surface the SAME '..'-segment safety skip the real transport applies, so the Publisher's
    // scrubbed-note path is exercised offline too.
    const skipped = files.map(f => f.filePath.replace(/^\.?\//, '')).filter(rel => rel.split(/[\\/]/).includes('..'))
    return { skipped }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  /** Every string surface a leak could ride: recorded commands + every staged file's path AND
   *  content. The leak tests assert a secret substring appears in NONE of these. */
  allRecordedText(): string[] {
    const out: string[] = [...this.commands]
    for (const p of this.puts) {
      out.push(p.targetDir)
      for (const f of p.files) { out.push(f.filePath); out.push(f.content) }
    }
    return out
  }

  /** Assert that NO recorded command/path/content contains `secret`. Throws (with a redacted
   *  message) on a leak so a test failure never itself echoes the secret. */
  assertNoLeak(secret: string): void {
    for (const text of this.allRecordedText()) {
      if (text.includes(secret)) throw new Error('LEAK: a secret substring appeared in a recorded SSH command or file')
    }
  }
}
