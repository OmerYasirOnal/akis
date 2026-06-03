import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    // Dev: proxy API + SSE to the backend so the FE is same-origin in prod and dev.
    proxy: {
      '/sessions': 'http://127.0.0.1:3000', '/api': 'http://127.0.0.1:3000',
      // ws:true so the backend's /preview WebSocket upgrade tunnel (vite HMR for a
      // RUNNING preview app) survives the dev proxy and reaches the backend.
      '/preview': { target: 'http://127.0.0.1:3000', ws: true },
      '/auth': 'http://127.0.0.1:3000',
      '/oauth': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // Playwright E2E lives under e2e/ and is NOT a vitest suite — exclude it so
    // `vitest run` (and the coverage run) never tries to execute it under jsdom.
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: {
      provider: 'v8',
      // Text summary in CI logs + lcov/html for local drill-down. coverage/ is gitignored.
      reporter: ['text-summary', 'html', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      // Non-product files: type-only decls, the bootstrap entry (untestable under jsdom),
      // the test setup, generated env shims, and the static i18n catalog (data, not logic).
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{ts,tsx}',
        'src/main.tsx',
        'src/test-setup.ts',
        'src/vite-env.d.ts',
        'src/i18n/catalog.ts',
      ],
      // PRAGMATIC gate: current measured line coverage is ~85.8% (2589/3017). The gate is
      // set to 80 — comfortably below current so it does NOT break CI on day one, while
      // still failing the build if coverage regresses meaningfully (>~6% drop).
      thresholds: { lines: 80 },
    },
  },
})
