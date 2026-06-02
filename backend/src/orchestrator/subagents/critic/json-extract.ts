/**
 * Robust JSON extraction from AI responses.
 * Handles markdown code fences, leading/trailing prose, and partial objects.
 * (Ported verbatim from AKIS v1.)
 */

export function parseAIJson<T = unknown>(text: string): T {
  // Strip markdown code fences
  let cleaned = text.trim();

  // Remove ```json ... ``` or ``` ... ``` wrappers
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch && fenceMatch[1]) {
    cleaned = fenceMatch[1].trim();
  }

  // If there's prose before/after, try to extract the JSON object/array
  const firstBrace = cleaned.search(/[[{]/);
  if (firstBrace > 0) {
    cleaned = cleaned.slice(firstBrace);
  }

  // Find matching closing brace/bracket
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end > 0) {
    cleaned = cleaned.slice(0, end + 1);
  }

  return JSON.parse(cleaned) as T;
}
