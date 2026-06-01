import { spawn } from 'node:child_process'

export interface RunResult {
  code: number | null   // null = killed (e.g. timeout) or spawn error
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface RunOpts {
  cwd: string
  env?: Record<string, string>   // explicit additions (e.g. PORT); merged over the scrubbed base
  timeoutMs?: number
}

/**
 * The process-execution seam. A stronger executor (Docker network=none / gVisor /
 * microVM / a separate signed verifier) drops in behind this interface later
 * WITHOUT touching callers. See THREAT-MODEL.md: LocalDirectSandbox is hygiene +
 * blast-radius reduction, NOT an isolation boundary.
 */
export interface Sandbox {
  run(cmd: string, args: string[], opts: RunOpts): Promise<RunResult>
}

/** Env-var NAMES that must never leak into a child process (AI keys, key store). */
const SECRET_ENV = /API_KEY|ANTHROPIC|OPENAI|OPENROUTER|GEMINI|^AI_|KEY_ENCRYPTION|KEY_STORE/i

/** Copy an env, dropping undefined values and any secret-bearing var (F: scrubbed env). */
export function scrubEnv(base: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SECRET_ENV.test(k)) continue
    out[k] = v
  }
  return out
}

/** SIGKILL the child's whole process group (detached spawn → own group), so a
 *  runaway build/test tree dies, not just the parent process. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
}

/**
 * Runs a command directly on the host (loopback, user privileges) with hygiene:
 * the child env is SCRUBBED of AI keys / key-store paths, the cwd is an ephemeral
 * workspace, and on timeout the whole process group is killed. Honest posture:
 * shares the kernel — not a security boundary (single-user self-host, by design).
 */
export class LocalDirectSandbox implements Sandbox {
  constructor(private baseEnv: Record<string, string | undefined> = process.env) {}

  run(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
    return new Promise(resolve => {
      const env = { ...scrubEnv(this.baseEnv), ...(opts.env ?? {}) }
      const child = spawn(cmd, args, { cwd: opts.cwd, env, detached: true })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      child.stdout?.on('data', d => { stdout += String(d) })
      child.stderr?.on('data', d => { stderr += String(d) })
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => { timedOut = true; killGroup(child.pid) }, opts.timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      }
      child.on('close', code => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }) })
      child.on('error', err => { if (timer) clearTimeout(timer); resolve({ code: null, stdout, stderr: stderr + String(err), timedOut }) })
    })
  }
}
