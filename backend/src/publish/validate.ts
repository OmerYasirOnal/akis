/**
 * SHAPE-validators for the publish destination — the SECURITY boundary for values that flow
 * from untrusted Settings into AKIS's OWN spawned `ssh`/`scp` argv. They mirror
 * `parseOwnerRepo`'s discipline (selectGitHubAdapter.ts): validate BEFORE any use; reject a
 * leading `-` (OpenSSH treats a leading-`-` "host" as an OPTION — `-oProxyCommand=touch /tmp/x`
 * would be RCE on the AKIS box, NOT the remote), reject shell metacharacters, `..`, newlines,
 * and quotes. Pure functions, no I/O. Enforced at the PUT route AND again at publish time
 * (defense-in-depth) before any command is built.
 */

/**
 * SSRF guard: the publish destination is BOTH an SSH target AND the host AKIS issues a
 * server-side GET to (the urlProbe). An authenticated caller must not be able to point that
 * server-side request at an internal address — loopback, the cloud metadata endpoint
 * (169.254.169.254), link-local, or an RFC1918 LAN host — turning the probe into a blind
 * internal port/reachability scanner. The documented self-host model is SINGLE-USER + loopback
 * (docs/SELF_HOSTING.md), so a localhost target is a legitimate workflow; the opt-in env
 * `AKIS_PUBLISH_ALLOW_INTERNAL=1` keeps that possible while the safe DEFAULT rejects internal
 * targets for the multi-tenant scaffolding the feature ships.
 */

/** The opt-in escape hatch: with `AKIS_PUBLISH_ALLOW_INTERNAL=1` set, internal/loopback/RFC1918
 *  publish targets are accepted (the single-user/loopback self-host story). Reads env at call time
 *  — no module-load capture — so a test or a deploy can flip it without re-import. */
export function allowInternalPublishTarget(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.AKIS_PUBLISH_ALLOW_INTERNAL === '1'
}

/** Hostnames that are ALWAYS internal regardless of DNS (obvious self/loopback/RFC names). The
 *  `.internal`/`.local`/`.localhost` suffixes are reserved for internal/mDNS use; `localhost` and
 *  the unqualified loopback names resolve to 127.0.0.1/::1. Matching is case-insensitive. */
function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h === 'ip6-localhost' || h === 'ip6-loopback') return true
  // metadata.google.internal and friends; *.internal / *.local / *.localhost are internal-only TLDs.
  return h.endsWith('.internal') || h.endsWith('.local') || h.endsWith('.localhost')
}

/** Classify a numeric IP literal (v4 or v6, optionally bracketed) as a non-routable/internal
 *  address: loopback (127/8, ::1), link-local + the cloud metadata range (169.254/16, fe80::/10),
 *  RFC1918 (10/8, 172.16/12, 192.168/16), unique-local IPv6 (fc00::/7), unspecified (0.0.0.0, ::),
 *  and IPv4-mapped IPv6 (::ffff:a.b.c.d → classified by the embedded v4). Returns false for a
 *  non-IP (a real hostname is handled separately / via DNS at probe time). */
function isInternalIpLiteral(raw: string): boolean {
  // Strip a single set of IPv6 brackets, e.g. [::1] → ::1.
  const ip = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  // IPv4 dotted-quad.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const oct = v4.slice(1).map(Number)
    if (oct.some(o => o > 255)) return false // not a valid v4 → let other checks handle it
    const [a, b] = oct as [number, number, number, number]
    if (a === 0) return true // 0.0.0.0/8 "this host"
    if (a === 127) return true // loopback
    if (a === 10) return true // RFC1918
    if (a === 169 && b === 254) return true // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true // RFC1918
    if (a === 192 && b === 168) return true // RFC1918
    return false
  }
  // IPv6 (must contain a colon to be a v6 literal at all).
  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    // IPv4-mapped/compatible: defer to the embedded v4 (::ffff:169.254.169.254, ::ffff:127.0.0.1).
    const mapped = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower)
    if (mapped) return isInternalIpLiteral(mapped[1] as string)
    if (lower === '::1' || lower === '::') return true // loopback / unspecified
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // fe80::/10 link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 unique-local
    return false
  }
  return false
}

/** True iff `host` (a hostname OR IP literal) is an internal/loopback/RFC1918/metadata target that
 *  must NOT be a publish destination unless the operator opted in. PURE + SYNCHRONOUS (syntactic
 *  classification only — a public-looking hostname that RESOLVES to a private IP is caught later by
 *  the DNS-resolving probe guard, defense-in-depth). */
export function isInternalPublishHost(host: string): boolean {
  return isInternalHostname(host) || isInternalIpLiteral(host)
}

/** A DNS hostname OR an IPv4/IPv6 literal. No leading/trailing hyphen or dot; a bracketed-IPv6
 *  form ([::1]) is accepted. The leading-hyphen rejection is the OpenSSH option-injection guard;
 *  the internal-address rejection is the SSRF guard (see isInternalPublishHost). */
export function validHost(host: unknown): host is string {
  if (typeof host !== 'string' || host.length === 0 || host.length > 255) return false
  let ok = false
  // Bracketed IPv6 literal, e.g. [2001:db8::1] — hex groups + ':' only inside the brackets.
  if (/^\[[0-9A-Fa-f:]+\]$/.test(host)) ok = true
  // A hostname / IPv4 literal: labels of [A-Za-z0-9-], dot-separated, no leading/trailing
  // hyphen or dot. A bare leading '-' (the option-injection vector) is rejected by the
  // [A-Za-z0-9] first char.
  else ok = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(host) && !host.includes('..')
  if (!ok) return false
  // SSRF guard: reject internal/loopback/RFC1918/metadata targets unless the operator opted in.
  if (!allowInternalPublishTarget() && isInternalPublishHost(host)) return false
  return true
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

/** Must parse as an http/https URL whose HOST is not an internal/loopback/RFC1918/metadata target
 *  (the SSRF guard — the publicUrl is what AKIS's server-side probe fetches). Anything else
 *  (javascript:, file:, garbage) is rejected by the protocol check. The internal-host rejection is
 *  bypassed only by AKIS_PUBLISH_ALLOW_INTERNAL=1. URL.hostname strips the brackets from a v6 host,
 *  so the IP classifier sees the bare literal. */
export function validPublicUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!allowInternalPublishTarget() && isInternalPublishHost(u.hostname)) return false
    return true
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

/** Resolve a hostname to its IP addresses. Injected into the probe guard so tests can model DNS
 *  (incl. a rebinding hostname → private IP) without real network. The default resolves ALL
 *  addresses (`all: true`) so a multi-A record can't slip a private IP past a first-only check. */
export type HostResolver = (host: string) => Promise<string[]>

/**
 * DEFENSE-IN-DEPTH SSRF guard for the urlProbe: a public-looking HOSTNAME can still RESOLVE to an
 * internal IP (DNS rebinding, or an attacker-controlled name pointing at 127.0.0.1 / the metadata
 * IP). The syntactic validHost/validPublicUrl checks can't see that; this guard RESOLVES the host
 * and rejects if ANY resolved address is internal. Call it immediately before the server-side
 * fetch. Returns false (do-not-fetch) on a resolution error too — fail-closed. Honors the
 * AKIS_PUBLISH_ALLOW_INTERNAL=1 opt-in (then it always allows, the single-user/loopback story).
 */
export async function isUrlSafeToProbe(url: string, resolver: HostResolver): Promise<boolean> {
  if (allowInternalPublishTarget()) return true
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  // An IP literal is classified directly (no DNS needed); URL.hostname already stripped v6 brackets.
  if (isInternalIpLiteral(host)) return false
  // A hostname that is itself an internal name (localhost, *.internal) — reject before any lookup.
  if (isInternalHostname(host)) return false
  try {
    const addrs = await resolver(host)
    if (addrs.length === 0) return false // resolved to nothing → don't fetch
    return !addrs.some(a => isInternalIpLiteral(a))
  } catch {
    return false // DNS failure → fail-closed, don't fetch
  }
}
