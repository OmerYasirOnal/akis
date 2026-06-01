import type { AppType } from './AppDetector.js'

export interface CmdSpec { cmd: string; args: string[] }
export interface StartSpec extends CmdSpec { env: Record<string, string> }

/**
 * Dependency install — pnpm with lifecycle scripts BLOCKED (--ignore-scripts), the
 * dominant install-step attack surface (THREAT-MODEL). Pure: returns the command.
 */
export function installSpec(): CmdSpec {
  return { cmd: 'pnpm', args: ['install', '--ignore-scripts', '--prefer-offline'] }
}

/**
 * The long-running start command for a previewable app, bound to a port on
 * loopback. Returns null for app types we don't run locally yet (static/unsupported
 * are deferred — see spec). Pure.
 */
export function startSpec(type: AppType, port: number): StartSpec | null {
  switch (type) {
    case 'vite':
      return { cmd: 'pnpm', args: ['exec', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], env: {} }
    case 'node-service':
      // `node .` runs package.json "main" (or index.js); the app must honor PORT.
      return { cmd: 'node', args: ['.'], env: { PORT: String(port), HOST: '127.0.0.1' } }
    case 'static':
    case 'unsupported':
      return null
  }
}
