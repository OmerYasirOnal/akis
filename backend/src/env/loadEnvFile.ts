import { readFileSync } from 'node:fs'

/**
 * Minimal, dependency-free .env loader (dotenv-format, NOT shell). Parses
 * `KEY=value` lines (optional `export `, surrounding quotes stripped, `#` comments
 * and blanks ignored) and sets `process.env[KEY]` ONLY when not already set — so an
 * explicit process env always wins over the file. Returns the keys it set.
 *
 * Robust to values that a shell `source` would choke on (spaces, `,`, URLs, etc.).
 * The file path comes from `AKIS_ENV_FILE` (or the passed path); secrets are never
 * logged. Used so the studio can run on a BYO `.env` (e.g. AI_PROVIDER + AI_API_KEY).
 */
export function loadEnvFile(path?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const file = path ?? env.AKIS_ENV_FILE
  if (!file) return []
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return [] }
  const set: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    let val = m[2]!.trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (env[key] === undefined) { env[key] = val; set.push(key) }
  }
  return set
}
