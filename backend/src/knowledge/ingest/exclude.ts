export interface ExclusionResult { excluded: boolean; reason?: string }

/** Source paths that must never be embedded (secrets at rest). */
const SECRET_SOURCE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|keys\.json)$/i

/**
 * Inline secret material patterns (API keys, private keys). For EXCLUSION, err on
 * the side of over-matching (a false positive merely keeps some text out of RAG;
 * a false negative leaks a secret). So: a leading boundary to avoid matching inside
 * words, but NO trailing `\b` — `\b` fails between an alphanumeric run and a
 * following `_`/letter/digit, which silently let real tokens (e.g. `ghp_…_v2`,
 * `sk-proj-…`) slip through. Bodies allow `-`/`_` where real keys use them.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/,        // Anthropic
  /\bsk-[A-Za-z0-9_-]{16,}/,            // OpenAI (incl. sk-proj-…)
  /\bAIza[0-9A-Za-z_-]{20,}/,           // Google API key
  /\bAKIA[0-9A-Z]{16}/,                 // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9_-]{10,}/,    // Slack token
  /\bgh[hpousr]_[A-Za-z0-9]{20,}/,      // GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/ghh_)
]

/** Fraction of non-printable chars above which content is treated as binary. */
const BINARY_RATIO = 0.3

/**
 * Decide whether content must be excluded BEFORE embedding (F1-AC12): secret-bearing
 * sources/content and binary blobs are never embedded; the reason is returned so the
 * caller can log/count it. Prerequisite for repo/upload ingestion (not deferred).
 */
export function shouldExclude(text: string, source: string): ExclusionResult {
  if (SECRET_SOURCE.test(source)) return { excluded: true, reason: `secret-source:${source}` }
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { excluded: true, reason: 'secret-content' }
  }
  if (isBinary(text)) return { excluded: true, reason: 'binary' }
  return { excluded: false }
}

/** Binary = a high fraction of non-printable (control, non-tab/newline) characters. */
function isBinary(text: string): boolean {
  if (text.length === 0) return false
  let nonPrintable = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const printable = c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127)
    if (!printable) nonPrintable++
  }
  return nonPrintable / text.length > BINARY_RATIO
}
