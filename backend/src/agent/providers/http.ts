/**
 * Shared HTTP helper for provider adapters: one POST-JSON path with retry +
 * backoff, typed errors, and an injectable fetch for tests. This module never
 * logs headers or bodies — adapters pass auth via `headers` and must not log it.
 */
export class AuthError extends Error {
  constructor(m = 'auth failed') { super(m); this.name = 'AuthError' }
}
export class ModelNotFoundError extends Error {
  constructor(m = 'model not found') { super(m); this.name = 'ModelNotFoundError' }
}
export class ProviderHttpError extends Error {
  constructor(public status: number, m: string, public body = '') { super(m); this.name = 'ProviderHttpError' }
}

export interface PostOpts {
  fetchFn?: typeof fetch
  maxRetries?: number
  baseDelayMs?: number
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * Pull a short, human-actionable reason out of a provider error body (Anthropic
 * `{error:{message}}`, OpenAI `{error:{message}}`, or a bare string), so a failed build
 * shows WHY (e.g. "messages.0: ...") instead of an opaque "provider HTTP 400". The
 * response body never contains the API key (the key is a request header), so this is safe
 * to surface. Truncated to keep it a one-liner.
 */
export function providerErrorDetail(body: string): string {
  if (!body) return ''
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string }
    const msg = typeof j.error === 'object' && j.error ? j.error.message
      : typeof j.error === 'string' ? j.error
      : j.message
    if (msg) return String(msg).slice(0, 300)
  } catch { /* not JSON — fall through to the raw body */ }
  return body.slice(0, 300)
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: PostOpts = {},
): Promise<T> {
  const fetchFn = opts.fetchFn ?? fetch
  const maxRetries = opts.maxRetries ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 250
  const timeoutMs = opts.timeoutMs ?? 60_000
  let attempt = 0
  for (;;) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let r: Response
    try {
      r = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (r.ok) return (await r.json()) as T
    if (r.status === 401 || r.status === 403) throw new AuthError()
    if (r.status === 404) throw new ModelNotFoundError()
    if ((r.status === 429 || r.status >= 500) && attempt < maxRetries) {
      const ra = Number(r.headers.get('retry-after'))
      const delay = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs
      attempt++
      await sleep(delay)
      continue
    }
    const errBody = await r.text().catch(() => '')
    const detail = providerErrorDetail(errBody)
    throw new ProviderHttpError(r.status, `provider HTTP ${r.status}${detail ? `: ${detail}` : ''}`, errBody)
  }
}
