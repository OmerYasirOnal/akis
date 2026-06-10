/**
 * Per-project repo-NAME derivation (A2.1). A build's GitHub repo name is derived from the
 * project's spec title (falling back to the idea) so each project gets its OWN repo in the
 * user's personal namespace — never a shared, surprising target. PURE + deterministic: no
 * network, no state, so it is trivially unit-testable (and the same input always yields the
 * same slug, which the retry/change-request reuse relies on).
 *
 * TR-SAFETY: a Turkish title ("Görev Takip Çizelgesi") must produce a clean ASCII repo name
 * ("gorev-takip-cizelgesi"), not a mojibake/empty one — GitHub repo names are ASCII-ish
 * ([A-Za-z0-9._-]), so the Turkish-specific letters are folded to their ASCII base BEFORE the
 * generic diacritic strip (İ/ı/ş/ğ/ü/ö/ç + uppercase). The result is lowercased, every run of
 * non-[a-z0-9] becomes a single dash, leading/trailing dashes are trimmed, and the length is
 * capped so a long title can't form an over-long ref.
 */

/** Max derived repo-name length. GitHub allows up to 100; we cap well under so a suffix
 *  (collision `-2`/`-3`) still fits and the URL stays readable. */
export const MAX_REPO_NAME = 60

/** Turkish-specific letter folds applied BEFORE the generic diacritic strip. The dotted/dotless
 *  i pair and the cedilla/breve letters do not always normalize to a clean ASCII base via NFD
 *  (notably the Turkish dotless 'ı' and capital dotted 'İ'), so map them explicitly. */
const TR_FOLD: Record<string, string> = {
  ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g',
  ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c',
}

/**
 * Slugify an arbitrary project title into a GitHub-safe repo name. Returns '' when the input
 * has NO usable alphanumeric content (the caller then falls back to a stable default).
 *
 *  - fold Turkish letters → ASCII (İ→i, ı→i, ş→s, ğ→g, ü→u, ö→o, ç→c, + uppercase);
 *  - NFD-decompose + strip remaining combining marks (é→e, ñ→n, …);
 *  - lowercase;
 *  - replace every run of non-[a-z0-9] with a single '-';
 *  - trim leading/trailing '-';
 *  - cap to MAX_REPO_NAME (then re-trim a trailing '-' the cut may have exposed).
 */
export function slugifyRepoName(raw: string): string {
  if (!raw) return ''
  // 1. Turkish-specific folds first (NFD alone mishandles ı / İ).
  let s = raw.replace(/[ıİşŞğĞüÜöÖçÇ]/g, ch => TR_FOLD[ch] ?? ch)
  // 2. Strip remaining diacritics via canonical decomposition + combining-mark removal.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  // 3. Lowercase, collapse non-alnum runs to single dashes, trim dashes.
  s = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // 4. Cap length, then re-trim a trailing dash the cut may have left.
  if (s.length > MAX_REPO_NAME) s = s.slice(0, MAX_REPO_NAME).replace(/-+$/g, '')
  return s
}

/**
 * Derive a base repo name from a session's project title (preferred) or idea (fallback).
 * Always returns a NON-empty name: an unsluggable title/idea (emoji-only, all punctuation)
 * yields the stable `akis-app` default so the destination is never empty.
 */
export function deriveRepoName(title: string | undefined, idea: string): string {
  return slugifyRepoName(title ?? '') || slugifyRepoName(idea) || 'akis-app'
}

/**
 * Deterministic collision suffix: `<base>-2`, `<base>-3`, … (attempt 0 = the bare base).
 * Keeps the whole name within MAX_REPO_NAME by trimming the BASE (not the suffix) when needed,
 * so the disambiguating suffix is never lost.
 */
export function suffixedRepoName(base: string, attempt: number): string {
  if (attempt <= 0) return base
  const suffix = `-${attempt + 1}` // attempt 1 → "-2", attempt 2 → "-3"
  const room = MAX_REPO_NAME - suffix.length
  const head = base.length > room ? base.slice(0, room).replace(/-+$/g, '') : base
  return `${head}${suffix}`
}

/** Bounded collision probes: base + `-2`…`-N`. Keeps a hostile/duplicate-heavy account from looping. */
export const MAX_COLLISION_PROBES = 5

/** The collision probe verdict: true (repo EXISTS), false (free), or undefined (UNKNOWN — a flaky
 *  probe / network error / 401-403-5xx). The resolver treats `undefined` as "fail open: take it". */
export type RepoExistsProbe = (repo: string) => Promise<boolean | undefined>

/**
 * A2.1 — pick a collision-free repo name from `base` by probing candidates: `base`, `base-2`, … up
 * to MAX_COLLISION_PROBES. A candidate that does NOT exist (false) — or whose existence is UNKNOWN
 * (undefined, a flaky/forbidden probe → fail open so a brand-new project still gets a destination) —
 * is taken immediately. Only a definite `true` (the repo already exists) advances to the next suffix,
 * so a brand-new project never pushes into an UNRELATED existing repo. If EVERY probed candidate
 * exists, the last suffixed name is returned (createRepo still GET-probes it idempotently). PURE w.r.t.
 * the injected probe, so the collision walk is unit-testable without any network.
 */
export async function resolveAvailableRepoName(base: string, probe: RepoExistsProbe): Promise<string> {
  for (let attempt = 0; attempt < MAX_COLLISION_PROBES; attempt++) {
    const candidate = suffixedRepoName(base, attempt)
    if ((await probe(candidate)) !== true) return candidate // false (free) or undefined (unknown) → take it
  }
  return suffixedRepoName(base, MAX_COLLISION_PROBES - 1) // every candidate existed → last suffixed name
}
