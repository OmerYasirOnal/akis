import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    // CODE-SPLIT (audit bigger-bet): the build used to emit ONE ~600KB chunk. Split the heavy,
    // rarely-changing vendor groups into their own cacheable chunks so they're fetched in parallel
    // + cached across deploys, and the markdown stack (react-markdown + the ~69 micromark/unified
    // transitive pkgs — the single biggest dep) is isolated. Lazy routes (App.tsx) handle the
    // "don't download the authed app on the login path" half.
    rollupOptions: {
      output: {
        // rolldown (vite 8) wants the FUNCTION form. Group the markdown stack (react-markdown +
        // its ~69 micromark/unified/mdast/hast transitive pkgs — the biggest dep) and the react
        // runtime into their own cacheable chunks; everything else falls through to the default
        // route-based splitting (App.tsx lazy()).
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react-markdown|remark-|micromark|mdast-|hast-|unist-|unified|decode-named|character-entities|property-information|space-separated|comma-separated|zwitch|html-url-attributes|trim-lines|vfile|bail|is-plain-obj|trough|ccount|escape-string-regexp|markdown-table|devlop|estree-util)/.test(id)) return 'markdown'
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
          return undefined
        },
      },
    },
  },
  server: {
    // Dev: proxy API + SSE to the backend so the FE is same-origin in prod and dev.
    proxy: {
      '/sessions': 'http://127.0.0.1:3000', '/api': 'http://127.0.0.1:3000',
      // ws:true so the backend's /preview WebSocket upgrade tunnel (vite HMR for a
      // RUNNING preview app) survives the dev proxy and reaches the backend.
      '/preview': { target: 'http://127.0.0.1:3000', ws: true },
      '/auth': 'http://127.0.0.1:3000',
      '/oauth': 'http://127.0.0.1:3000', '/health': 'http://127.0.0.1:3000',
      // Publish destination (Settings → deploy-to-your-own-server). Without this the dev FE's
      // /publish/profile fetch falls through to the SPA fallback (HTML), which the page used to
      // misread as "encryption not configured".
      '/publish': 'http://127.0.0.1:3000',
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
