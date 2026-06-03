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
    // Quoted: capture everything between the OUTER matching quotes — a greedy
    // capture to the LAST quote keeps inner quotes and `#` (e.g. JSON) intact —
    // allowing only an optional trailing ` # comment` after the close quote. Without
    // a clean enclosing pair (unbalanced quote, or trailing junk like `"abc"def`),
    // fall through to the unquoted branch so trailing content is never silently dropped.
    const dq = /^"(.*)"\s*(?:#.*)?$/.exec(val)
    const sq = /^'(.*)'\s*(?:#.*)?$/.exec(val)
    if (dq) {
      val = dq[1]!
    } else if (sq) {
      val = sq[1]!
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
