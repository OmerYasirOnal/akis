import type { SshTransport, SshExecResult, SshRunOpts } from './SshTransport.js'

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
 */
export class FakeSshTransport implements SshTransport {
  /** Every remote command, in call order. */
  readonly commands: string[] = []
  /** Every putFiles call's payload, in call order. */
  readonly puts: { files: { filePath: string; content: string }[]; targetDir: string }[] = []
  closed = false

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

  async putFiles(files: { filePath: string; content: string }[], targetDir: string): Promise<void> {
    this.puts.push({ files: files.map(f => ({ ...f })), targetDir })
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
