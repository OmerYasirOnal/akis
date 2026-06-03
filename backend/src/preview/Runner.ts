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
 *
 * `sessionId` threads the same-origin proxy prefix into the dev server so emitted
 * asset URLs carry `/preview/<id>/` and resolve against the AKIS origin instead of
 * being root-absolute (which 404'd and white-screened the SPA). Vite honors `--base`
 * NATIVELY. Next does NOT read a base path from env on its own — we only EXPOSE it as
 * NEXT_PUBLIC_BASE_PATH for the generated app's own next.config to wire into
 * basePath/assetPrefix; an app that doesn't do so still boots but serves root-absolute
 * assets under the proxy (a documented Next-preview limitation — see SELF_HOSTING.md).
 */
export function startSpec(type: AppType, port: number, sessionId = ''): StartSpec | null {
  const base = `/preview/${sessionId}/`
  switch (type) {
    case 'vite':
      return { cmd: 'pnpm', args: ['exec', 'vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1', '--base', base], env: {} }
    case 'next':
      // `next dev` on the port; the proxy prefix is EXPOSED as NEXT_PUBLIC_BASE_PATH for the
      // generated app's own next.config to honor (we don't rewrite its config). Without that
      // wiring the app serves root-absolute assets under the proxy — a documented limitation.
      return { cmd: 'pnpm', args: ['exec', 'next', 'dev', '--port', String(port), '--hostname', '127.0.0.1'], env: { PORT: String(port), HOST: '127.0.0.1', NEXT_PUBLIC_BASE_PATH: sessionId ? base.replace(/\/$/, '') : '' } }
    case 'node-service':
      // `node .` runs package.json "main" (or index.js); the app must honor PORT.
      return { cmd: 'node', args: ['.'], env: { PORT: String(port), HOST: '127.0.0.1' } }
    case 'static':
    case 'unsupported':
      return null
  }
}
