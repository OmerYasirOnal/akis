import { readFileSync } from 'node:fs'

/**
 * Minimal, dependency-free .env loader (dotenv-format, NOT shell). Parses
 * `KEY=value` lines (optional `export `, surrounding quotes stripped, blanks and
 * `#` comments — both whole-line and unquoted inline ` # ...` — ignored) and sets
 * `process.env[KEY]` ONLY when not already set — so an explicit process env always
 * wins over the file. Returns the keys it set. A `#` inside a quoted value is kept.
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
    const quoted = /^"([^"]*)"|^'([^']*)'/.exec(val)
    if (quoted) {
      // Quoted: keep everything between the matching quotes (`#` is legitimate
      // here); anything trailing after the close-quote (e.g. ` # comment`) is dropped.
      val = quoted[1] ?? quoted[2] ?? ''
    } else {
      // Unquoted: strip an inline comment — a `#` at the value's start or
      // preceded by whitespace — then re-trim. A `#` with no leading space
      // (e.g. `a#b`) is part of the value and is left intact.
      val = val.replace(/(^|\s+)#.*$/, '').trim()
    }
    if (env[key] === undefined) { env[key] = val; set.push(key) }
  }
  return set
}
