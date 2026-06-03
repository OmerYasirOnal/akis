import { defineConfig, devices } from '@playwright/test'

/**
 * Hermetic E2E config for the AKIS frontend smoke.
 *
 * How it stays hermetic + deterministic:
 * - It builds the FE and serves ONLY the static `dist/` via `vite preview`. There is NO
 *   backend, NO LLM key, NO secret, and NO external network call. The anon `/` route
 *   renders the public marketing Landing (the AuthProvider's GET /auth/me has no server
 *   to hit, so it resolves to "not signed in" and the Landing shows) — a fully offline,
 *   repeatable happy path.
 * - Chromium only, single worker, no retries locally → fast + stable. CI may add retries.
 *
 * The `webServer` block builds + serves automatically, so `playwright test` is one command.
 */
const PORT = 4317
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // Keep the smoke fast and deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Build the app once, then serve the static bundle. No env, no secrets — fully offline.
  webServer: {
    // Bind preview to 127.0.0.1 explicitly: `vite preview` otherwise binds only to
    // `localhost`, which can resolve to IPv6 (::1) and make the IPv4 probe URL hang.
    command: `pnpm build && pnpm exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
