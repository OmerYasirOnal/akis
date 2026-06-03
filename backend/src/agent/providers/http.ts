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
 * shows WHY (e.g. "messages.0: ...") instead of an opaque "provider HTTP 400". When the
 * body carries no message — e.g. Google/Gemini's `{error:{code,status}}` — fall back to a
 * compact `status`/`code` (e.g. "INVALID_ARGUMENT") rather than dumping the raw JSON blob.
 * The response body never contains the API key (the key is a request header), so this is
 * safe to surface. Truncated to keep it a one-liner.
 */
export function providerErrorDetail(body: string): string {
  if (!body) return ''
  try {
    const j = JSON.parse(body) as {
      error?: { message?: string; status?: string; code?: string | number } | string
      message?: string
    }
    const msg = typeof j.error === 'object' && j.error ? j.error.message
      : typeof j.error === 'string' ? j.error
      : j.message
    if (msg) return String(msg).slice(0, 300)
    // No message, but a structured error (Gemini): surface the symbolic status, else the code.
    if (typeof j.error === 'object' && j.error) {
      const fallback = j.error.status ?? j.error.code
      if (fallback != null && fallback !== '') return String(fallback).slice(0, 300)
    }
  } catch { /* not JSON — fall through to the raw body */ }
  return body.slice(0, 300)
}

/**
 * Stream a provider response as Server-Sent-Events: POST `body`, then hand each
 * parsed `data:` payload to `onEvent`. Mirrors `postJson`'s auth/timeout surface
 * (same typed errors, same injectable fetch) but does NOT retry — a retry mid-stream
 * would replay already-emitted deltas, so a failed stream surfaces to the caller (the
 * route falls back to the non-stream path). Bytes are decoded incrementally and split
 * on blank-line frame boundaries; each frame's `data:` line value is forwarded (the
 * OpenAI `[DONE]` sentinel is filtered so it never reaches the adapter). Whether a
 * payload is JSON-for-this-adapter is the adapter's concern — this layer is transport
 * + framing only.
 */
export async function streamSse(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  onEvent: (data: string) => void,
  opts: PostOpts = {},
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? 60_000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let r: Response
  try {
    r = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    throw e
  }
  if (!r.ok) {
    clearTimeout(timer)
    if (r.status === 401 || r.status === 403) throw new AuthError()
    if (r.status === 404) throw new ModelNotFoundError()
    const errBody = await r.text().catch(() => '')
    const detail = providerErrorDetail(errBody)
    throw new ProviderHttpError(r.status, `provider HTTP ${r.status}${detail ? `: ${detail}` : ''}`, errBody)
  }
  if (!r.body) { clearTimeout(timer); throw new ProviderHttpError(0, 'streaming response had no body') }

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  // Forward every `data:` line in a frame (one SSE frame may carry several).
  const flushFrame = (frame: string): void => {
    for (const line of frame.split('\n')) {
      const trimmed = line.trimStart()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue // OpenAI terminator
      onEvent(payload)
    }
  }
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // Process each complete frame (blank-line terminated); keep the trailing partial.
      let idx: number
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2))
        flushFrame(frame)
      }
    }
    // A provider that ends without a trailing blank line still has a final frame.
    if (buf.trim()) flushFrame(buf)
  } finally {
    clearTimeout(timer)
  }
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
