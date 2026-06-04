import type { ChatRequest, ChatResult, LlmProvider } from './LlmProvider.js'

/**
 * Output-truncation recovery for single-shot producer calls (Proto writes a WHOLE app in
 * one reply, so hitting the output cap used to truncate the JSON mid-string → unparseable →
 * a silent placeholder stub shipped as a "successful" build).
 *
 * Every provider adapter forwards its raw finish reason into `ChatResult.stopReason`
 * (anthropic `max_tokens`, openai-compatible `length`, gemini `MAX_TOKENS`). When the reply
 * stopped on the CAP — not a natural stop — we re-call with the partial text as an assistant
 * turn plus a minimal "continue exactly where you left off" user turn, and CONCATENATE.
 * This is the provider-documented continuation pattern; the system prompt is resent verbatim
 * so provider-side prompt caching keeps the repeated prefix cheap.
 *
 * Fail-open by design: with no `stopReason` (older adapter, mock) or a natural stop this is
 * exactly ONE chat() call with the result passed through untouched. Rounds are bounded so a
 * model that keeps hitting the cap cannot loop forever — the assembled text is returned and
 * the caller's parser decides (Proto's parse() still degrades to its explicit non-parsed
 * placeholder, which the tool_result honestly reports as ok:false).
 */
const TRUNCATED = new Set(['max_tokens', 'MAX_TOKENS', 'length'])

/** One continuation turn; phrased so the model resumes mid-token without re-emitting. */
const CONTINUE_PROMPT = 'Continue EXACTLY where you left off. Do not repeat anything already written; do not restart the JSON — resume mid-string if needed.'

/** How far back we look for a repeated seam when joining a continuation (chars). */
const MAX_OVERLAP = 2000

/**
 * Join a continuation onto the accumulated text, TRIMMING any re-emitted overlap: models
 * are instructed not to repeat, but a model that restates the tail of the partial (or even
 * restarts from a recent line) would otherwise corrupt the concatenation (doubled JSON).
 * We find the LONGEST suffix of `acc` that is also a prefix of `next` (bounded) and drop it
 * from `next`. A non-overlapping continuation is appended unchanged — the guard is pure
 * defense and can never remove non-duplicated content.
 */
export function joinContinuation(acc: string, next: string): string {
  const max = Math.min(acc.length, next.length, MAX_OVERLAP)
  for (let n = max; n > 0; n--) {
    if (acc.endsWith(next.slice(0, n))) return acc + next.slice(n)
  }
  return acc + next
}

export async function chatWithContinuation(
  provider: LlmProvider,
  req: ChatRequest,
  maxContinues = 3,
): Promise<ChatResult> {
  let res = await provider.chat(req)
  let text = res.text ?? ''
  // Real cost across ALL rounds — returning only the last round's usage would under-report
  // (a truncated 16k round + a 3k continue is 19k out, not 3k) and corrupt billing/quota math.
  const usage = res.usage ? { ...res.usage } : undefined
  let rounds = 0
  while (res.stopReason !== undefined && TRUNCATED.has(res.stopReason) && rounds < maxContinues) {
    rounds++
    res = await provider.chat({
      ...req,
      messages: [
        ...req.messages,
        { role: 'assistant', content: text },
        { role: 'user', content: CONTINUE_PROMPT },
      ],
    })
    text = joinContinuation(text, res.text ?? '')
    if (res.usage && usage) { usage.inTokens += res.usage.inTokens; usage.outTokens += res.usage.outTokens }
  }
  return { ...res, text, ...(usage ? { usage } : {}) }
}
