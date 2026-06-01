import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    // Dev: proxy API + SSE to the backend so the FE is same-origin in prod and dev.
    proxy: { '/sessions': 'http://127.0.0.1:3000', '/api': 'http://127.0.0.1:3000', '/preview': 'http://127.0.0.1:3000' },
  },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts'] },
})
