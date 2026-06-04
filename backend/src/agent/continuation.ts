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

export async function chatWithContinuation(
  provider: LlmProvider,
  req: ChatRequest,
  maxContinues = 3,
): Promise<ChatResult> {
  let res = await provider.chat(req)
  let text = res.text ?? ''
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
    text += res.text ?? ''
  }
  return { ...res, text }
}
