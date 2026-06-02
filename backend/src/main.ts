import { loadEnvFile } from './env/loadEnvFile.js'
import { start } from './api/server.js'

/** Production / dev entry: load a BYO env file (AKIS_ENV_FILE, dotenv-format —
 *  e.g. AI_PROVIDER + AI_API_KEY + AI_MODEL) without overriding the real process
 *  env, then boot the AKIS HTTP + SSE server. */
const loaded = loadEnvFile()
if (loaded.length) console.info(`env: loaded ${loaded.length} keys from ${process.env.AKIS_ENV_FILE}`)

start().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('failed to start AKIS backend:', err)
  process.exit(1)
})
