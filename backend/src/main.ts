import { start } from './api/server.js'

/** Production / dev entry: boot the AKIS HTTP + SSE server. */
start().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('failed to start AKIS backend:', err)
  process.exit(1)
})
