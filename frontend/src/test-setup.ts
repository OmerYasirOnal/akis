import '@testing-library/jest-dom'

// jsdom in this config does not provide Web Storage, but production (a browser) always does.
// Install a tiny in-memory localStorage/sessionStorage so component tests that persist UI
// state (e.g. the AKIS chat thread, recent builds) exercise the real persistence path.
class MemStorage implements Storage {
  private data = new Map<string, string>()
  get length(): number { return this.data.size }
  clear(): void { this.data.clear() }
  getItem(key: string): string | null { return this.data.has(key) ? this.data.get(key)! : null }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null }
  removeItem(key: string): void { this.data.delete(key) }
  setItem(key: string, value: string): void { this.data.set(key, String(value)) }
}

if (typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemStorage(), configurable: true })
}
if (typeof globalThis.sessionStorage === 'undefined') {
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemStorage(), configurable: true })
}
