/**
 * Map a provider SLUG (the wire value the `done` event carries on `provider`) to a human display
 * label for the Shipped card (P1-5). The Shipped card renders a pure FOLDED message, so it has no
 * access to the runtime `/api/providers` catalog (which is fetched async AND deliberately excludes
 * 'mock') — hence this small static map. The four real labels mirror the backend provider catalog
 * (`backend/src/agent/providers/catalog.ts`) VERBATIM so the studio reads identically everywhere;
 * 'mock' → "Demo" (the catalog has no mock row — it is the keyless/simulated mode).
 *
 * UNKNOWN slug → returned AS-IS (never blank, never a crash): a future/forgotten provider still
 * surfaces its raw id rather than vanishing.
 */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic (Claude)',
  openai: 'OpenAI',
  google: 'Google (Gemini)',
  openrouter: 'OpenRouter',
  mock: 'Demo',
}

/** Display label for a provider slug; unknown/blank slugs pass through unchanged (no crash). */
export function providerLabel(slug: string): string {
  return PROVIDER_LABELS[slug] ?? slug
}
