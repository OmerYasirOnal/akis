/**
 * SHAPE-validators for the publish destination — the SECURITY boundary for values that flow
 * from untrusted Settings into AKIS's OWN spawned `ssh`/`scp` argv. They mirror
 * `parseOwnerRepo`'s discipline (selectGitHubAdapter.ts): validate BEFORE any use; reject a
 * leading `-` (OpenSSH treats a leading-`-` "host" as an OPTION — `-oProxyCommand=touch /tmp/x`
 * would be RCE on the AKIS box, NOT the remote), reject shell metacharacters, `..`, newlines,
 * and quotes. Pure functions, no I/O. Enforced at the PUT route AND again at publish time
 * (defense-in-depth) before any command is built.
 */

/** A DNS hostname OR an IPv4/IPv6 literal. No leading/trailing hyphen or dot; a bracketed-IPv6
 *  form ([::1]) is accepted. The leading-hyphen rejection is the OpenSSH option-injection guard. */
export function validHost(host: unknown): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false
  // Bracketed IPv6 literal, e.g. [2001:db8::1] — hex groups + ':' only inside the brackets.
  if (/^\[[0-9A-Fa-f:]+\]$/.test(host)) return true
  // A hostname / IPv4 literal: labels of [A-Za-z0-9-], dot-separated, no leading/trailing
  // hyphen or dot. A bare leading '-' (the option-injection vector) is rejected by the
  // [A-Za-z0-9] first char.
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(host) && !host.includes('..')
}

/** A POSIX login name: starts with a lowercase letter or underscore, then [a-z0-9_-], ≤32 chars.
 *  Rejects a leading `-` (which OpenSSH would read as an option). */
export function validSshUser(user: unknown): user is string {
  return typeof user === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(user)
}

/** An ABSOLUTE POSIX path. Rejects `..`, backticks, `$`, `;`, `&`, `|`, newlines, quotes, spaces,
 *  and any char outside [A-Za-z0-9._/-] — so it can never break out of a remote shell command. */
export function validTargetDir(dir: unknown): dir is string {
  if (typeof dir !== 'string' || !dir.startsWith('/') || dir.length > 4096) return false
  if (!/^\/[A-Za-z0-9._/-]+$/.test(dir)) return false
  if (dir.includes('..')) return false // no parent-dir traversal
  return true
}

/** An app port a NON-ROOT login user can bind: 1025..65535 (≤1024 needs root). Integer only. */
export function validAppPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1025 && port <= 65535
}

/** Must parse as an http/https URL. Anything else (javascript:, file:, garbage) is rejected. */
export function validPublicUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Must look like a PEM private key block. We do NOT parse the key (no crypto dependency on the
 *  exact format) — only confirm it is plausibly a private key so a typo'd paste fails at the
 *  route, not mid-deploy. The full block is the secret; never log it. */
export function looksLikePem(pem: unknown): pem is string {
  if (typeof pem !== 'string') return false
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(pem.trim())
}
