import { test, expect } from '@playwright/test'

/**
 * Hermetic happy-path smoke: load the served static build at `/` and assert the public
 * marketing Landing renders. NO backend, NO auth, NO LLM, NO external network — the
 * AuthProvider's session probe has no server to reach, so the app falls through to the
 * anonymous Landing. We assert on stable, copy-driven elements (the page title and the
 * i18n landing headline / primary CTA) rather than on styling that can churn.
 */
test('landing screen renders for an anonymous visitor', async ({ page }) => {
  await page.goto('/')

  // The document title is set in index.html and is the most stable signal the app booted.
  await expect(page).toHaveTitle(/AKIS/i)

  // The hero headline is the English default ('landing.headline' in the i18n catalog).
  await expect(
    page.getByRole('heading', { name: /Describe an app\. Watch agents build/i }).first(),
  ).toBeVisible()

  // A primary call-to-action proves the interactive landing (not an error/blank page) mounted.
  await expect(page.getByRole('button', { name: /Get started/i }).first()).toBeVisible()
})
