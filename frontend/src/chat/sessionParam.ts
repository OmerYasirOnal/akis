/**
 * Read the `?s=<id>` deep-link session id from a location.search string. The History page
 * navigates to `/?s=<id>` to open a build in the Studio across the (page-level) router;
 * ChatStudio reads this on mount and loads that session. Pure + null-safe so it's testable
 * without a DOM. Returns undefined when absent/empty. */
export function sessionIdFromSearch(search: string): string | undefined {
  const qs = search.startsWith('?') ? search.slice(1) : search
  const id = new URLSearchParams(qs).get('s')?.trim()
  return id ? id : undefined
}
