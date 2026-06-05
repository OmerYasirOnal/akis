import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { UsageStore, type UsageStorePort, type UsageRecord } from './UsageStore.js'

/**
 * DEV-ONLY file-persisted usage ledger: the in-memory {@link UsageStore} plus a JSON file
 * (~/.akis/dev-usage.json, 0600) saved on every `add` and loaded on boot — so editing backend
 * code (which restarts tsx-watch and wipes process memory) does not silently RESET per-user
 * usage counters mid-window. Mirrors {@link JsonFileUserStore} exactly.
 *
 * Scope and honesty:
 *  - DEV ONLY. Production uses PgUsageStore when DATABASE_URL is set; NODE_ENV=test always uses
 *    the pure in-memory UsageStore (no test writes the real ~/.akis).
 *  - Token counts are NOT secrets (the codebase already treats them so). Still 0600 for hygiene.
 *  - Persistence is BEST-EFFORT (an unwritable disk degrades to in-memory with a warn-once,
 *    never a crash). Reads/writes are synchronous, so a successful save means the file is
 *    current before the request returns.
 */
export class JsonFileUsageStore implements UsageStorePort {
  private inner: UsageStore
  private warned = false

  constructor(periodMs: number, private file = join(homedir(), '.akis', 'dev-usage.json')) {
    this.inner = new UsageStore({ periodMs })
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(raw)) {
        // Tolerant hydrate: keep only rows that look like records (a hand-edited/corrupted file
        // never crashes the boot — bad rows are simply dropped).
        const records = raw.filter((r): r is UsageRecord =>
          !!r && typeof r === 'object'
          && typeof (r as UsageRecord).ownerId === 'string'
          && typeof (r as UsageRecord).usedTokens === 'number'
          && typeof (r as UsageRecord).periodTokens === 'number'
          && typeof (r as UsageRecord).windowStart === 'string')
        this.inner.hydrate(records)
      }
    } catch { /* first boot (no file yet) or unreadable — start empty */ }
  }

  /** Save the full snapshot (0600). Best-effort: a write failure warns once and the store
   *  keeps working in-memory — never a crash. */
  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.inner.snapshot(), null, 2), { mode: 0o600 })
      chmodSync(this.file, 0o600) // mode above is masked by umask — chmod makes 0600 unconditional
    } catch {
      if (!this.warned) {
        this.warned = true
        // eslint-disable-next-line no-console
        console.warn('usage: dev-usage file unwritable — per-user usage will reset on restart (in-memory only)')
      }
    }
  }

  async add(ownerId: string, tokens: number, now?: number): Promise<void> {
    await this.inner.add(ownerId, tokens, now)
    this.persist()
  }
  get(ownerId: string, now?: number): Promise<UsageRecord> { return this.inner.get(ownerId, now) }
  snapshotAll(): Promise<UsageRecord[]> { return this.inner.snapshotAll() }
}
