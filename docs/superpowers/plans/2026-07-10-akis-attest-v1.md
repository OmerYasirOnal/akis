# AKIS Attest v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `akis-attest` v1 — a zero-runtime-dependency CLI that records human approval gates and really-run test results in a hash-chained ledger, mints an Ed25519-signed in-toto/DSSE attestation, and exports a single self-verifying static `proof.html` a client can open anywhere.

**Architecture:** A single TypeScript package. `src/core/` holds pure, unit-tested primitives (canonical JSON, hash-chained ledger, Ed25519 keys, DSSE envelope, git helpers, config, test-runner capture, attestation builder). `src/commands/` maps six CLI commands onto those primitives with fail-closed rules. `src/page/` renders the self-contained proof page (embedded JSON bundle + inline WebCrypto verifier + EN/TR strings). Everything the client receives is static; there is no server.

**Tech Stack:** Node ≥22 (node:crypto Ed25519, node:util parseArgs, node:child_process), TypeScript strict ESM, pnpm, vitest (unit/integration), Playwright+Chromium (proof-page E2E). **Zero runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-10-akis-attest-design.md` (in the akis-platform-mvp repo). This plan implements v1 scope only — Sigstore, GitHub Action wrapper, and hosted portal are explicitly out (spec §3).

## Global Constraints

- New repo at `~/Projects/akis-attest`, branch `main`. The GitHub repo creation and any npm publish are **owner-gated** (Task 15 notes them; never push/publish without the owner).
- `engines.node >= 22`; `"type": "module"`; TypeScript `strict: true`.
- **Zero runtime dependencies** — only `node:*` built-ins at runtime. Dev deps allowed: typescript, tsx, @types/node, vitest, @playwright/test.
- CLI binary name `attest`, package name `akis-attest`. All CLI messages in **English**. Proof page is **EN+TR**.
- **Fail-closed, verbatim from spec:** `approve delivery` refuses when the working tree is dirty or when HEAD has no recorded PASS verify (recorded with `dirty: false`). `export` refuses without a completed `approve_delivery` unless `--draft` (visible watermark, unsigned). A failed test run is recorded as FAIL — **success is never faked**; unparsable test output is recorded as `'unparsed'`, never invented.
- Ledger is append-only JSONL; every event carries `prevHash`/`hash` (SHA-256 over canonical JSON of the event without `hash`); genesis `prevHash` is 64 zeros.
- Constants: `STATEMENT_TYPE = 'https://in-toto.io/Statement/v1'`, `PREDICATE_TYPE = 'https://omeryasironal.com/akis-attest/predicate/v1'`, `PAYLOAD_TYPE = 'application/vnd.in-toto+json'`.
- Signing keys live under `process.env.AKIS_ATTEST_HOME ?? ~/.config/akis-attest/` (tests always set `AKIS_ATTEST_HOME` to a temp dir).
- Commit after every green step; conventional-commit messages.

## File Structure (final)

```
akis-attest/
  package.json  tsconfig.json  tsconfig.build.json  vitest.config.ts  .gitignore
  .github/workflows/ci.yml
  src/
    cli.ts                 # arg parsing + dispatch, exit codes
    core/encoding.ts       # canonicalJson, sha256Hex, base64
    core/ledger.ts         # append/read/verifyChain
    core/keys.ts           # Ed25519 keygen/load/sign/verify, fingerprint
    core/dsse.ts           # PAE, sign/verify envelope
    core/git.ts            # isGitRepo, headSha, isDirty, gitUser
    core/config.ts         # .attest/config.json types + IO
    core/testRun.ts        # run test command + boot-smoke, capture results
    core/attestation.ts    # in-toto statement build + write signed envelope
    commands/init.ts  commands/approve.ts  commands/verify.ts
    commands/export.ts  commands/check.ts
    page/template.ts       # proof.html renderer (inline verifier JS + CSS)
    page/i18n.ts           # EN+TR string catalog
  test/
    helpers.ts             # tmp dirs, fixture git repo factory
    unit/*.test.ts         # one file per core module
    integration/flow.test.ts
  e2e/proof.spec.ts  playwright.config.ts
  README.md
```

---

### Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.gitignore`

**Interfaces:**
- Produces: a compiling empty package every later task builds on; scripts `test`, `typecheck`, `build`.

- [ ] **Step 1: Create the repo and files**

```bash
mkdir -p ~/Projects/akis-attest && cd ~/Projects/akis-attest && git init -b main
```

`package.json`:
```json
{
  "name": "akis-attest",
  "version": "0.1.0",
  "description": "Ship AI-built work with proof: human-approved gates, really-run tests, a signed attestation, one shareable link.",
  "type": "module",
  "license": "Apache-2.0",
  "engines": { "node": ">=22" },
  "bin": { "attest": "./dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "build": "tsc -p tsconfig.build.json",
    "e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.60.0",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^2.1.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "e2e"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "declaration": true },
  "include": ["src"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
```

`.gitignore`:
```
node_modules/
dist/
test-results/
playwright-report/
```

- [ ] **Step 2: Install and verify**

Run: `pnpm install && pnpm typecheck`
Expected: install succeeds; typecheck passes (no source files yet).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: scaffold akis-attest package (Node 22, strict TS, zero runtime deps)"
```

---

### Task 2: Encoding primitives

**Files:**
- Create: `src/core/encoding.ts`
- Test: `test/unit/encoding.test.ts`

**Interfaces:**
- Produces: `canonicalJson(value: unknown): string` (sorted keys, no whitespace, throws on `undefined`/function), `sha256Hex(data: string | Uint8Array): string`, `toBase64(data: Uint8Array | string): string`, `fromBase64(b64: string): Buffer`.

- [ ] **Step 1: Write the failing test**

`test/unit/encoding.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { canonicalJson, fromBase64, sha256Hex, toBase64 } from '../../src/core/encoding.js'

describe('canonicalJson', () => {
  it('sorts object keys recursively and emits no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 'x'], c: null } })).toBe('{"a":{"c":null,"d":[2,"x"]},"b":1}')
  })
  it('is stable regardless of insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }))
  })
  it('throws on undefined and functions', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow()
    expect(() => canonicalJson({ a: () => 1 })).toThrow()
  })
})

describe('sha256Hex / base64', () => {
  it('hashes known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('round-trips base64', () => {
    expect(fromBase64(toBase64('hello')).toString('utf8')).toBe('hello')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/encoding.test.ts`
Expected: FAIL — cannot find module `src/core/encoding.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/encoding.ts`:
```ts
import { createHash } from 'node:crypto'

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'number' || t === 'boolean') return JSON.stringify(value)
  if (t === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`
  if (t === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
  }
  throw new Error(`canonicalJson: cannot serialize value of type ${t}`)
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

export function toBase64(data: Uint8Array | string): string {
  return Buffer.from(data).toString('base64')
}

export function fromBase64(b64: string): Buffer {
  return Buffer.from(b64, 'base64')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/encoding.test.ts` — Expected: PASS.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/encoding.ts test/unit/encoding.test.ts
git commit -m "feat(core): canonical JSON, sha256, base64 primitives"
```

---

### Task 3: Hash-chained ledger

**Files:**
- Create: `src/core/ledger.ts`, `test/helpers.ts`
- Test: `test/unit/ledger.test.ts`

**Interfaces:**
- Consumes: `canonicalJson`, `sha256Hex` from Task 2.
- Produces:
  - `type EventKind = 'init' | 'approve_plan' | 'verify' | 'approve_delivery'`
  - `interface LedgerEvent { seq: number; ts: string; kind: EventKind; gitSha: string; dirty: boolean; actor: string; payload: Record<string, unknown>; prevHash: string; hash: string }`
  - `const GENESIS_HASH: string` (64 zeros)
  - `appendEvent(attestDir: string, input: { kind: EventKind; gitSha: string; dirty: boolean; actor: string; payload: Record<string, unknown>; ts?: string }): LedgerEvent`
  - `readLedger(attestDir: string): LedgerEvent[]`
  - `verifyChain(events: LedgerEvent[]): { ok: true } | { ok: false; brokenAtSeq: number; reason: string }`
  - `test/helpers.ts` produces `tmpDir(): string` (fresh temp dir, auto-registered for cleanup).

- [ ] **Step 1: Write the failing test**

`test/helpers.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

const created: string[] = []

export function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'attest-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) rmSync(created.pop()!, { recursive: true, force: true })
})
```

`test/unit/ledger.test.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENESIS_HASH, appendEvent, readLedger, verifyChain } from '../../src/core/ledger.js'
import { tmpDir } from '../helpers.js'

function seed(dir: string) {
  appendEvent(dir, { kind: 'init', gitSha: 'a'.repeat(40), dirty: false, actor: 'Tester <t@x>', payload: {} })
  appendEvent(dir, { kind: 'approve_plan', gitSha: 'a'.repeat(40), dirty: false, actor: 'Tester <t@x>', payload: { message: 'scope' } })
}

describe('ledger', () => {
  it('chains events: seq increments, prevHash links, genesis is zeros', () => {
    const dir = tmpDir()
    seed(dir)
    const events = readLedger(dir)
    expect(events).toHaveLength(2)
    expect(events[0]!.seq).toBe(1)
    expect(events[0]!.prevHash).toBe(GENESIS_HASH)
    expect(events[1]!.prevHash).toBe(events[0]!.hash)
    expect(verifyChain(events)).toEqual({ ok: true })
  })

  it('detects a tampered payload', () => {
    const dir = tmpDir()
    seed(dir)
    const path = join(dir, 'ledger.jsonl')
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    const ev = JSON.parse(lines[1]!)
    ev.payload.message = 'tampered'
    lines[1] = JSON.stringify(ev)
    writeFileSync(path, lines.join('\n') + '\n')
    const res = verifyChain(readLedger(dir))
    expect(res).toMatchObject({ ok: false, brokenAtSeq: 2 })
  })

  it('detects a deleted event (broken prevHash link)', () => {
    const dir = tmpDir()
    seed(dir)
    appendEvent(dir, { kind: 'verify', gitSha: 'a'.repeat(40), dirty: false, actor: 'Tester <t@x>', payload: { pass: true } })
    const path = join(dir, 'ledger.jsonl')
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n')
    const res = verifyChain(readLedger(dir))
    expect(res.ok).toBe(false)
  })

  it('readLedger returns [] when file does not exist', () => {
    expect(readLedger(tmpDir())).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/ledger.test.ts`
Expected: FAIL — cannot find module `src/core/ledger.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/ledger.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJson, sha256Hex } from './encoding.js'

export type EventKind = 'init' | 'approve_plan' | 'verify' | 'approve_delivery'

export interface LedgerEvent {
  seq: number
  ts: string
  kind: EventKind
  gitSha: string
  dirty: boolean
  actor: string
  payload: Record<string, unknown>
  prevHash: string
  hash: string
}

export const GENESIS_HASH = '0'.repeat(64)

function ledgerPath(attestDir: string): string {
  return join(attestDir, 'ledger.jsonl')
}

function computeHash(event: Omit<LedgerEvent, 'hash'>): string {
  return sha256Hex(canonicalJson(event))
}

export function readLedger(attestDir: string): LedgerEvent[] {
  const path = ledgerPath(attestDir)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as LedgerEvent)
}

export function appendEvent(
  attestDir: string,
  input: { kind: EventKind; gitSha: string; dirty: boolean; actor: string; payload: Record<string, unknown>; ts?: string },
): LedgerEvent {
  mkdirSync(attestDir, { recursive: true })
  const events = readLedger(attestDir)
  const prev = events[events.length - 1]
  const unhashed: Omit<LedgerEvent, 'hash'> = {
    seq: (prev?.seq ?? 0) + 1,
    ts: input.ts ?? new Date().toISOString(),
    kind: input.kind,
    gitSha: input.gitSha,
    dirty: input.dirty,
    actor: input.actor,
    payload: input.payload,
    prevHash: prev?.hash ?? GENESIS_HASH,
  }
  const event: LedgerEvent = { ...unhashed, hash: computeHash(unhashed) }
  appendFileSync(ledgerPath(attestDir), JSON.stringify(event) + '\n')
  return event
}

export function verifyChain(events: LedgerEvent[]): { ok: true } | { ok: false; brokenAtSeq: number; reason: string } {
  let prevHash = GENESIS_HASH
  for (const event of events) {
    const { hash, ...unhashed } = event
    if (event.prevHash !== prevHash) {
      return { ok: false, brokenAtSeq: event.seq, reason: 'prevHash does not match previous event hash' }
    }
    if (computeHash(unhashed) !== hash) {
      return { ok: false, brokenAtSeq: event.seq, reason: 'event content does not match its hash' }
    }
    prevHash = hash
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/ledger.test.ts` — Expected: PASS (4 tests).
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/ledger.ts test/unit/ledger.test.ts test/helpers.ts
git commit -m "feat(core): hash-chained append-only ledger with tamper detection"
```

---

### Task 4: Ed25519 keys

**Files:**
- Create: `src/core/keys.ts`
- Test: `test/unit/keys.test.ts`

**Interfaces:**
- Consumes: `sha256Hex`, `toBase64`, `fromBase64` (Task 2).
- Produces:
  - `attestHome(): string` — `process.env.AKIS_ATTEST_HOME ?? join(homedir(), '.config', 'akis-attest')`
  - `interface KeyPair { privateKeyPem: string; publicKeySpkiB64: string; fingerprint: string }` (fingerprint = full sha256 hex of the SPKI DER)
  - `ensureKeyPair(): KeyPair` — loads if present, else generates and writes `key.pem` (mode 0600) + `key.pub.pem`
  - `signBytes(data: Uint8Array, privateKeyPem: string): string` (base64 signature)
  - `verifyBytes(data: Uint8Array, sigB64: string, publicKeySpkiB64: string): boolean`

- [ ] **Step 1: Write the failing test**

`test/unit/keys.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { attestHome, ensureKeyPair, signBytes, verifyBytes } from '../../src/core/keys.js'
import { tmpDir } from '../helpers.js'

describe('keys', () => {
  it('generates once, then reloads the same key', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const a = ensureKeyPair()
    const b = ensureKeyPair()
    expect(a.fingerprint).toBe(b.fingerprint)
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(attestHome()).toBe(process.env.AKIS_ATTEST_HOME)
  })

  it('signs and verifies; rejects tampered data and wrong key', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const kp = ensureKeyPair()
    const data = new TextEncoder().encode('payload')
    const sig = signBytes(data, kp.privateKeyPem)
    expect(verifyBytes(data, sig, kp.publicKeySpkiB64)).toBe(true)
    expect(verifyBytes(new TextEncoder().encode('tampered'), sig, kp.publicKeySpkiB64)).toBe(false)
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const other = ensureKeyPair()
    expect(verifyBytes(data, sig, other.publicKeySpkiB64)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/keys.test.ts`
Expected: FAIL — cannot find module `src/core/keys.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/keys.ts`:
```ts
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fromBase64, sha256Hex, toBase64 } from './encoding.js'

export interface KeyPair {
  privateKeyPem: string
  publicKeySpkiB64: string
  fingerprint: string
}

export function attestHome(): string {
  return process.env.AKIS_ATTEST_HOME ?? join(homedir(), '.config', 'akis-attest')
}

function derive(privateKeyPem: string): KeyPair {
  const publicKey = createPublicKey(createPrivateKey(privateKeyPem))
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' })
  return { privateKeyPem, publicKeySpkiB64: toBase64(spkiDer), fingerprint: sha256Hex(spkiDer) }
}

export function ensureKeyPair(): KeyPair {
  const home = attestHome()
  const keyPath = join(home, 'key.pem')
  if (existsSync(keyPath)) return derive(readFileSync(keyPath, 'utf8'))
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  mkdirSync(home, { recursive: true })
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 })
  writeFileSync(join(home, 'key.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }).toString())
  return derive(privateKeyPem)
}

export function signBytes(data: Uint8Array, privateKeyPem: string): string {
  return toBase64(sign(null, data, createPrivateKey(privateKeyPem)))
}

export function verifyBytes(data: Uint8Array, sigB64: string, publicKeySpkiB64: string): boolean {
  try {
    const publicKey = createPublicKey({ key: fromBase64(publicKeySpkiB64), format: 'der', type: 'spki' })
    return verify(null, data, publicKey, fromBase64(sigB64))
  } catch {
    return false
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/keys.test.ts` — Expected: PASS.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/keys.ts test/unit/keys.test.ts
git commit -m "feat(core): Ed25519 keypair with fingerprint, sign/verify"
```

---

### Task 5: DSSE envelope

**Files:**
- Create: `src/core/dsse.ts`
- Test: `test/unit/dsse.test.ts`

**Interfaces:**
- Consumes: Task 2 encoding, Task 4 keys.
- Produces:
  - `pae(payloadType: string, payload: Uint8Array): Uint8Array` — DSSE v1 pre-authentication encoding
  - `interface DsseEnvelope { payloadType: string; payload: string; signatures: Array<{ keyid: string; sig: string; publicKeySpki: string }> }`
  - `signEnvelope(payloadType: string, payloadBytes: Uint8Array): DsseEnvelope` (uses `ensureKeyPair()`)
  - `verifyEnvelope(env: DsseEnvelope): boolean`

- [ ] **Step 1: Write the failing test**

`test/unit/dsse.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { pae, signEnvelope, verifyEnvelope } from '../../src/core/dsse.js'
import { toBase64 } from '../../src/core/encoding.js'
import { tmpDir } from '../helpers.js'

describe('dsse', () => {
  it('pae matches the DSSE v1 spec shape', () => {
    const out = new TextDecoder().decode(pae('t', new TextEncoder().encode('pp')))
    expect(out).toBe('DSSEv1 1 t 2 pp')
  })

  it('sign/verify round-trips and detects payload tampering', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const env = signEnvelope('application/vnd.in-toto+json', new TextEncoder().encode('{"a":1}'))
    expect(verifyEnvelope(env)).toBe(true)
    expect(verifyEnvelope({ ...env, payload: toBase64('{"a":2}') })).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/dsse.test.ts`
Expected: FAIL — cannot find module `src/core/dsse.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/dsse.ts`:
```ts
import { fromBase64, toBase64 } from './encoding.js'
import { ensureKeyPair, signBytes, verifyBytes } from './keys.js'

export interface DsseEnvelope {
  payloadType: string
  payload: string
  signatures: Array<{ keyid: string; sig: string; publicKeySpki: string }>
}

export function pae(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(payloadType)
  const header = new TextEncoder().encode(`DSSEv1 ${typeBytes.length} ${payloadType} ${payload.length} `)
  const out = new Uint8Array(header.length + payload.length)
  out.set(header)
  out.set(payload, header.length)
  return out
}

export function signEnvelope(payloadType: string, payloadBytes: Uint8Array): DsseEnvelope {
  const kp = ensureKeyPair()
  const sig = signBytes(pae(payloadType, payloadBytes), kp.privateKeyPem)
  return {
    payloadType,
    payload: toBase64(payloadBytes),
    signatures: [{ keyid: kp.fingerprint, sig, publicKeySpki: kp.publicKeySpkiB64 }],
  }
}

export function verifyEnvelope(env: DsseEnvelope): boolean {
  const first = env.signatures[0]
  if (!first) return false
  return verifyBytes(pae(env.payloadType, fromBase64(env.payload)), first.sig, first.publicKeySpki)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/dsse.test.ts` — Expected: PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/dsse.ts test/unit/dsse.test.ts
git commit -m "feat(core): DSSE v1 envelope sign/verify with PAE"
```

---

### Task 6: Git helpers

**Files:**
- Create: `src/core/git.ts`
- Modify: `test/helpers.ts` (add fixture repo factory)
- Test: `test/unit/git.test.ts`

**Interfaces:**
- Produces:
  - `isGitRepo(cwd: string): boolean`
  - `headSha(cwd: string): string` (40-hex, throws if no commits)
  - `isDirty(cwd: string): boolean` (any staged/unstaged/untracked change)
  - `gitUser(cwd: string): string` — `"Name <email>"`, or `'unknown'` when unset
  - helpers: `fixtureRepo(): string` — temp dir with `git init`, one commit, local user config `Fixture <fx@test>`.

- [ ] **Step 1: Write the failing test**

Append to `test/helpers.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { writeFileSync as wf } from 'node:fs'

export function fixtureRepo(): string {
  const dir = tmpDir()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-b', 'main')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fx@test')
  wf(`${dir}/app.txt`, 'v1\n')
  git('add', '-A')
  git('commit', '-m', 'initial')
  return dir
}
```

`test/unit/git.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitUser, headSha, isDirty, isGitRepo } from '../../src/core/git.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

describe('git helpers', () => {
  it('detects a repo, reads HEAD sha and user', () => {
    const repo = fixtureRepo()
    expect(isGitRepo(repo)).toBe(true)
    expect(headSha(repo)).toMatch(/^[0-9a-f]{40}$/)
    expect(gitUser(repo)).toBe('Fixture <fx@test>')
  })
  it('detects dirty tree (untracked and modified)', () => {
    const repo = fixtureRepo()
    expect(isDirty(repo)).toBe(false)
    writeFileSync(join(repo, 'new.txt'), 'x')
    expect(isDirty(repo)).toBe(true)
  })
  it('non-repo dir: isGitRepo false', () => {
    expect(isGitRepo(tmpDir())).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/git.test.ts`
Expected: FAIL — cannot find module `src/core/git.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/git.ts`:
```ts
import { execFileSync } from 'node:child_process'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, 'rev-parse', '--is-inside-work-tree') === 'true'
  } catch {
    return false
  }
}

export function headSha(cwd: string): string {
  return git(cwd, 'rev-parse', 'HEAD')
}

export function isDirty(cwd: string): boolean {
  return git(cwd, 'status', '--porcelain') !== ''
}

export function gitUser(cwd: string): string {
  try {
    const name = git(cwd, 'config', 'user.name')
    const email = git(cwd, 'config', 'user.email')
    if (name === '' || email === '') return 'unknown'
    return `${name} <${email}>`
  } catch {
    return 'unknown'
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/git.test.ts` — Expected: PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/git.ts test/unit/git.test.ts test/helpers.ts
git commit -m "feat(core): git helpers (repo detection, HEAD sha, dirty flag, user)"
```

---

### Task 7: Config + `attest init` + CLI dispatch

**Files:**
- Create: `src/core/config.ts`, `src/commands/init.ts`, `src/cli.ts`
- Test: `test/unit/config.test.ts`, `test/unit/init.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4, 6.
- Produces:
  - `interface AttestConfig { version: 1; project: string; actor: string; test: { command: string; timeoutMs?: number }; bootSmoke?: { command: string; url: string; expectStatus?: number; timeoutMs?: number }; artifacts?: string[]; lang?: 'en' | 'tr' }`
  - `attestDir(cwd: string): string` → `join(cwd, '.attest')`
  - `loadConfig(cwd: string): AttestConfig` (throws `Error('not initialized — run `attest init` first')` if missing)
  - `saveConfig(cwd: string, cfg: AttestConfig): void`
  - `runInit(argv: string[], cwd: string): number` — flags `--project`, `--actor`, `--test-command`; defaults: dir basename, `gitUser(cwd)`, `'npm test'`; creates config + keypair + `init` ledger event. Refuses (exit 1, `error: not a git repo`) outside git; refuses if already initialized.
  - `src/cli.ts` produces the dispatch used by ALL later command tasks: `main(argv: string[]): Promise<number>` mapping `init | approve | verify | export | check` to `run<Cmd>(rest, process.cwd())`; unknown command prints usage, exit 2. Every `run*` has signature `(argv: string[], cwd: string) => number | Promise<number>`.

- [ ] **Step 1: Write the failing tests**

`test/unit/config.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { attestDir, loadConfig, saveConfig, type AttestConfig } from '../../src/core/config.js'
import { tmpDir } from '../helpers.js'

describe('config', () => {
  it('round-trips config and errors when missing', () => {
    const cwd = tmpDir()
    expect(() => loadConfig(cwd)).toThrow(/attest init/)
    const cfg: AttestConfig = { version: 1, project: 'demo', actor: 'A <a@x>', test: { command: 'npm test' } }
    saveConfig(cwd, cfg)
    expect(loadConfig(cwd)).toEqual(cfg)
    expect(attestDir(cwd).endsWith('.attest')).toBe(true)
  })
})
```

`test/unit/init.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runInit } from '../../src/commands/init.js'
import { loadConfig } from '../../src/core/config.js'
import { attestDir } from '../../src/core/config.js'
import { readLedger } from '../../src/core/ledger.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

describe('attest init', () => {
  it('creates config, keypair and genesis event', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    expect(runInit(['--project', 'demo', '--test-command', 'echo ok'], repo)).toBe(0)
    const cfg = loadConfig(repo)
    expect(cfg.project).toBe('demo')
    expect(cfg.actor).toBe('Fixture <fx@test>')
    const events = readLedger(attestDir(repo))
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('init')
  })
  it('refuses outside a git repo and refuses double init', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    expect(runInit([], tmpDir())).toBe(1)
    const repo = fixtureRepo()
    expect(runInit([], repo)).toBe(0)
    expect(runInit([], repo)).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/config.test.ts test/unit/init.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/config.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AttestConfig {
  version: 1
  project: string
  actor: string
  test: { command: string; timeoutMs?: number }
  bootSmoke?: { command: string; url: string; expectStatus?: number; timeoutMs?: number }
  artifacts?: string[]
  lang?: 'en' | 'tr'
}

export function attestDir(cwd: string): string {
  return join(cwd, '.attest')
}

function configPath(cwd: string): string {
  return join(attestDir(cwd), 'config.json')
}

export function loadConfig(cwd: string): AttestConfig {
  const path = configPath(cwd)
  if (!existsSync(path)) throw new Error('not initialized — run `attest init` first')
  return JSON.parse(readFileSync(path, 'utf8')) as AttestConfig
}

export function saveConfig(cwd: string, cfg: AttestConfig): void {
  mkdirSync(attestDir(cwd), { recursive: true })
  writeFileSync(configPath(cwd), JSON.stringify(cfg, null, 2) + '\n')
}
```

`src/commands/init.ts`:
```ts
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { attestDir, saveConfig, type AttestConfig } from '../core/config.js'
import { gitUser, headSha, isDirty, isGitRepo } from '../core/git.js'
import { ensureKeyPair } from '../core/keys.js'
import { appendEvent } from '../core/ledger.js'

export function runInit(argv: string[], cwd: string): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      project: { type: 'string' },
      actor: { type: 'string' },
      'test-command': { type: 'string' },
    },
  })
  if (!isGitRepo(cwd)) {
    console.error('error: not a git repo — attest binds proofs to git commits, run `git init` first')
    return 1
  }
  if (existsSync(join(attestDir(cwd), 'config.json'))) {
    console.error('error: already initialized (.attest/config.json exists)')
    return 1
  }
  const cfg: AttestConfig = {
    version: 1,
    project: values.project ?? basename(cwd),
    actor: values.actor ?? gitUser(cwd),
    test: { command: values['test-command'] ?? 'npm test' },
  }
  saveConfig(cwd, cfg)
  const kp = ensureKeyPair()
  appendEvent(attestDir(cwd), {
    kind: 'init',
    gitSha: headSha(cwd),
    dirty: isDirty(cwd),
    actor: cfg.actor,
    payload: { keyFingerprint: kp.fingerprint, project: cfg.project },
  })
  console.log(`initialized .attest for "${cfg.project}" (key ${kp.fingerprint.slice(0, 16)}…)`)
  return 0
}
```

`src/cli.ts`:
```ts
#!/usr/bin/env node
import { runInit } from './commands/init.js'

const USAGE = `attest — ship AI-built work with proof

Usage:
  attest init [--project X] [--actor "Name <email>"] [--test-command CMD]
  attest approve <plan|delivery> -m "message"
  attest verify
  attest export [--draft] [--out proof.html]
  attest check [path]
`

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  switch (command) {
    case 'init':
      return runInit(rest, process.cwd())
    // approve / verify / export / check are wired in by later tasks:
    // case 'approve': return runApprove(rest, process.cwd())
    // case 'verify': return runVerify(rest, process.cwd())
    // case 'export': return runExport(rest, process.cwd())
    // case 'check': return runCheck(rest, process.cwd())
    default:
      console.error(USAGE)
      return 2
  }
}

const invokedDirectly = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/config.test.ts test/unit/init.test.ts` — Expected: PASS.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/commands/init.ts src/cli.ts test/unit/config.test.ts test/unit/init.test.ts
git commit -m "feat(cli): attest init + config + command dispatch"
```

---

### Task 8: `attest approve plan`

**Files:**
- Create: `src/commands/approve.ts`
- Modify: `src/cli.ts` (uncomment/wire `case 'approve'`)
- Test: `test/unit/approve-plan.test.ts`

**Interfaces:**
- Consumes: config, ledger, git (Tasks 3/6/7).
- Produces: `runApprove(argv: string[], cwd: string): number`. `attest approve plan -m "..."` appends `approve_plan` with `payload: { message }`. `-m` is required (exit 1 without it). A dirty tree is ALLOWED for plan (recorded in the event's `dirty` flag) — plan approval is about scope, not code state. `attest approve delivery` is added in Task 10; until then approve.ts routes only `plan` and returns exit 1 `error: unknown gate` for anything else.

- [ ] **Step 1: Write the failing test**

`test/unit/approve-plan.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runApprove } from '../../src/commands/approve.js'
import { runInit } from '../../src/commands/init.js'
import { attestDir } from '../../src/core/config.js'
import { readLedger } from '../../src/core/ledger.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

describe('attest approve plan', () => {
  it('records an approve_plan event with the message', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit([], repo)
    expect(runApprove(['plan', '-m', 'Build the contact form'], repo)).toBe(0)
    const events = readLedger(attestDir(repo))
    expect(events[1]!.kind).toBe('approve_plan')
    expect(events[1]!.payload).toEqual({ message: 'Build the contact form' })
  })
  it('requires -m and a known gate', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit([], repo)
    expect(runApprove(['plan'], repo)).toBe(1)
    expect(runApprove(['nope', '-m', 'x'], repo)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/approve-plan.test.ts`
Expected: FAIL — cannot find module `src/commands/approve.js`.

- [ ] **Step 3: Write minimal implementation**

`src/commands/approve.ts`:
```ts
import { parseArgs } from 'node:util'
import { attestDir, loadConfig } from '../core/config.js'
import { headSha, isDirty } from '../core/git.js'
import { appendEvent } from '../core/ledger.js'

export function runApprove(argv: string[], cwd: string): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { message: { type: 'string', short: 'm' } },
    allowPositionals: true,
  })
  const gate = positionals[0]
  if (gate !== 'plan' && gate !== 'delivery') {
    console.error('error: unknown gate — use `attest approve plan` or `attest approve delivery`')
    return 1
  }
  if (values.message === undefined || values.message.trim() === '') {
    console.error('error: -m "message" is required (what are you approving?)')
    return 1
  }
  const cfg = loadConfig(cwd)
  if (gate === 'plan') {
    const event = appendEvent(attestDir(cwd), {
      kind: 'approve_plan',
      gitSha: headSha(cwd),
      dirty: isDirty(cwd),
      actor: cfg.actor,
      payload: { message: values.message },
    })
    console.log(`plan approved (seq ${event.seq}) — "${values.message}"`)
    return 0
  }
  console.error('error: delivery gate not implemented yet')
  return 1
}
```

In `src/cli.ts`, wire the command (replace the commented line):
```ts
import { runApprove } from './commands/approve.js'
// inside switch:
    case 'approve':
      return runApprove(rest, process.cwd())
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/approve-plan.test.ts` — Expected: PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/approve.ts src/cli.ts test/unit/approve-plan.test.ts
git commit -m "feat(cli): attest approve plan gate"
```

---

### Task 9: Test runner capture + `attest verify`

**Files:**
- Create: `src/core/testRun.ts`, `src/commands/verify.ts`
- Modify: `src/cli.ts` (wire `case 'verify'`)
- Test: `test/unit/testRun.test.ts`, `test/unit/verify.test.ts`

**Interfaces:**
- Consumes: config, ledger, git, encoding.
- Produces:
  - `interface TestRunResult { command: string; exitCode: number; durationMs: number; pass: boolean; tests: { passed: number; failed: number } | 'unparsed'; outputDigest: string; env: { node: string; platform: string; lockfileSha256: string | null } }`
  - `runTests(cwd: string, command: string, timeoutMs?: number): TestRunResult` — `spawnSync` with `shell: true`, captures stdout+stderr, `pass = exitCode === 0`, best-effort summary parse via regexes `/(\d+)\s+passed/` and `/(\d+)\s+failed/` (vitest/jest text output); no match on `passed` → `'unparsed'`. `lockfileSha256` = sha256 of the first existing of `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, else null.
  - `interface BootSmokeResult { command: string; url: string; status: number | null; pass: boolean; durationMs: number }`
  - `runBootSmoke(cwd: string, cfg: NonNullable<AttestConfig['bootSmoke']>): Promise<BootSmokeResult>` — spawns the command detached, polls `fetch(url)` every 250ms until `expectStatus ?? 200` or `timeoutMs ?? 30000`, then kills the process group.
  - `runVerify(argv: string[], cwd: string): Promise<number>` — runs tests (+ boot-smoke when configured), appends a `verify` event whose payload is `{ ...TestRunResult, bootSmoke?: BootSmokeResult }` with top-level `pass` reflecting BOTH (tests pass AND boot-smoke pass when present). Exit 0 on pass, 1 on fail — but the event is appended EITHER WAY (failures are recorded, never hidden).

- [ ] **Step 1: Write the failing tests**

`test/unit/testRun.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runTests } from '../../src/core/testRun.js'
import { fixtureRepo } from '../helpers.js'

describe('runTests', () => {
  it('captures a passing run and parses a vitest-style summary', () => {
    const repo = fixtureRepo()
    const res = runTests(repo, 'echo "Tests  3 passed (3)"')
    expect(res.pass).toBe(true)
    expect(res.exitCode).toBe(0)
    expect(res.tests).toEqual({ passed: 3, failed: 0 })
    expect(res.outputDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(res.env.node).toBe(process.version)
  })
  it('captures a failing run', () => {
    const res = runTests(fixtureRepo(), 'exit 1')
    expect(res.pass).toBe(false)
    expect(res.exitCode).toBe(1)
  })
  it('marks unparsable output as unparsed', () => {
    const res = runTests(fixtureRepo(), 'echo "all good"')
    expect(res.tests).toBe('unparsed')
    expect(res.pass).toBe(true)
  })
})
```

`test/unit/verify.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { runInit } from '../../src/commands/init.js'
import { runVerify } from '../../src/commands/verify.js'
import { attestDir } from '../../src/core/config.js'
import { readLedger } from '../../src/core/ledger.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

describe('attest verify', () => {
  it('appends a passing verify event and exits 0', async () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit(['--test-command', 'echo "Tests  2 passed (2)"'], repo)
    expect(await runVerify([], repo)).toBe(0)
    const last = readLedger(attestDir(repo)).at(-1)!
    expect(last.kind).toBe('verify')
    expect(last.payload.pass).toBe(true)
  })
  it('records a FAILING run honestly and exits 1', async () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit(['--test-command', 'exit 1'], repo)
    expect(await runVerify([], repo)).toBe(1)
    const last = readLedger(attestDir(repo)).at(-1)!
    expect(last.kind).toBe('verify')
    expect(last.payload.pass).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/testRun.test.ts test/unit/verify.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

`src/core/testRun.ts`:
```ts
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform } from 'node:os'
import { sha256Hex } from './encoding.js'
import type { AttestConfig } from './config.js'

export interface TestRunResult {
  command: string
  exitCode: number
  durationMs: number
  pass: boolean
  tests: { passed: number; failed: number } | 'unparsed'
  outputDigest: string
  env: { node: string; platform: string; lockfileSha256: string | null }
}

function lockfileSha256(cwd: string): string | null {
  for (const name of ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']) {
    const path = join(cwd, name)
    if (existsSync(path)) return sha256Hex(readFileSync(path))
  }
  return null
}

function parseSummary(output: string): TestRunResult['tests'] {
  const passed = /(\d+)\s+passed/.exec(output)
  if (!passed) return 'unparsed'
  const failed = /(\d+)\s+failed/.exec(output)
  return { passed: Number(passed[1]), failed: failed ? Number(failed[1]) : 0 }
}

export function runTests(cwd: string, command: string, timeoutMs = 600_000): TestRunResult {
  const started = Date.now()
  const res = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
  const exitCode = res.status ?? -1
  return {
    command,
    exitCode,
    durationMs: Date.now() - started,
    pass: exitCode === 0,
    tests: parseSummary(output),
    outputDigest: sha256Hex(output),
    env: { node: process.version, platform: `${platform()}`, lockfileSha256: lockfileSha256(cwd) },
  }
}

export interface BootSmokeResult {
  command: string
  url: string
  status: number | null
  pass: boolean
  durationMs: number
}

export async function runBootSmoke(
  cwd: string,
  cfg: NonNullable<AttestConfig['bootSmoke']>,
): Promise<BootSmokeResult> {
  const started = Date.now()
  const expect = cfg.expectStatus ?? 200
  const deadline = started + (cfg.timeoutMs ?? 30_000)
  const child = spawn(cfg.command, { cwd, shell: true, detached: true, stdio: 'ignore' })
  let status: number | null = null
  try {
    while (Date.now() < deadline) {
      try {
        const res = await fetch(cfg.url)
        status = res.status
        if (status === expect) break
      } catch {
        /* server not up yet */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
  }
  return { command: cfg.command, url: cfg.url, status, pass: status === expect, durationMs: Date.now() - started }
}
```

`src/commands/verify.ts`:
```ts
import { attestDir, loadConfig } from '../core/config.js'
import { headSha, isDirty } from '../core/git.js'
import { appendEvent } from '../core/ledger.js'
import { runBootSmoke, runTests, type BootSmokeResult } from '../core/testRun.js'

export async function runVerify(_argv: string[], cwd: string): Promise<number> {
  const cfg = loadConfig(cwd)
  console.log(`running: ${cfg.test.command}`)
  const result = runTests(cwd, cfg.test.command, cfg.test.timeoutMs)
  let bootSmoke: BootSmokeResult | undefined
  if (cfg.bootSmoke) {
    console.log(`boot-smoke: ${cfg.bootSmoke.command} → ${cfg.bootSmoke.url}`)
    bootSmoke = await runBootSmoke(cwd, cfg.bootSmoke)
  }
  const pass = result.pass && (bootSmoke?.pass ?? true)
  appendEvent(attestDir(cwd), {
    kind: 'verify',
    gitSha: headSha(cwd),
    dirty: isDirty(cwd),
    actor: cfg.actor,
    payload: { ...result, pass, ...(bootSmoke ? { bootSmoke } : {}) },
  })
  console.log(pass ? `verify PASS (${result.durationMs}ms)` : `verify FAIL (exit ${result.exitCode})`)
  return pass ? 0 : 1
}
```

Wire in `src/cli.ts`: `case 'verify': return runVerify(rest, process.cwd())` (add the import).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/testRun.test.ts test/unit/verify.test.ts` — Expected: PASS.
Run: `pnpm typecheck` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/testRun.ts src/commands/verify.ts src/cli.ts test/unit/testRun.test.ts test/unit/verify.test.ts
git commit -m "feat(cli): attest verify — really-run tests + optional boot-smoke, failures recorded honestly"
```

---

### Task 10: `attest approve delivery` (fail-closed)

**Files:**
- Modify: `src/commands/approve.ts`
- Test: `test/unit/approve-delivery.test.ts`

**Interfaces:**
- Consumes: ledger `readLedger`, git `headSha`/`isDirty`.
- Produces: `attest approve delivery -m "..."` appends `approve_delivery` ONLY when (a) working tree is clean, (b) the ledger contains a `verify` event with `gitSha === headSha(cwd)`, `dirty === false`, and `payload.pass === true`. Refusal messages (exact): `error: working tree is dirty — commit your changes first`, `error: no passing verify for HEAD — run \`attest verify\` on a clean tree first`.

- [ ] **Step 1: Write the failing test**

`test/unit/approve-delivery.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runApprove } from '../../src/commands/approve.js'
import { runInit } from '../../src/commands/init.js'
import { runVerify } from '../../src/commands/verify.js'
import { attestDir } from '../../src/core/config.js'
import { readLedger } from '../../src/core/ledger.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

async function readyRepo(): Promise<string> {
  process.env.AKIS_ATTEST_HOME = tmpDir()
  const repo = fixtureRepo()
  runInit(['--test-command', 'echo "Tests  1 passed (1)"'], repo)
  await runVerify([], repo)
  return repo
}

describe('attest approve delivery (fail-closed)', () => {
  it('approves when HEAD has a clean passing verify', async () => {
    const repo = await readyRepo()
    expect(runApprove(['delivery', '-m', 'v1 to client'], repo)).toBe(0)
    expect(readLedger(attestDir(repo)).at(-1)!.kind).toBe('approve_delivery')
  })
  it('refuses on a dirty tree', async () => {
    const repo = await readyRepo()
    writeFileSync(join(repo, 'junk.txt'), 'x')
    expect(runApprove(['delivery', '-m', 'x'], repo)).toBe(1)
  })
  it('refuses without any verify for HEAD', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit([], repo)
    expect(runApprove(['delivery', '-m', 'x'], repo)).toBe(1)
  })
  it('refuses when the only verify for HEAD failed', async () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit(['--test-command', 'exit 1'], repo)
    await runVerify([], repo)
    expect(runApprove(['delivery', '-m', 'x'], repo)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/approve-delivery.test.ts`
Expected: FAIL — 'approves when HEAD has a clean passing verify' fails (`delivery gate not implemented yet` path returns 1).

- [ ] **Step 3: Implement delivery in `src/commands/approve.ts`**

Replace the `console.error('error: delivery gate not implemented yet'); return 1` tail with:
```ts
  // gate === 'delivery' — fail-closed rules (spec §4.1 / §5)
  if (isDirty(cwd)) {
    console.error('error: working tree is dirty — commit your changes first')
    return 1
  }
  const sha = headSha(cwd)
  const events = readLedger(attestDir(cwd))
  const verifyForHead = [...events]
    .reverse()
    .find((e) => e.kind === 'verify' && e.gitSha === sha && e.dirty === false)
  if (!verifyForHead || verifyForHead.payload.pass !== true) {
    console.error('error: no passing verify for HEAD — run `attest verify` on a clean tree first')
    return 1
  }
  const event = appendEvent(attestDir(cwd), {
    kind: 'approve_delivery',
    gitSha: sha,
    dirty: false,
    actor: cfg.actor,
    payload: { message: values.message, verifySeq: verifyForHead.seq },
  })
  console.log(`delivery approved (seq ${event.seq}) — "${values.message}"`)
  return 0
```

Add `readLedger` to the ledger import in the same file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/approve-delivery.test.ts` — Expected: PASS (4 tests).
Run: `pnpm vitest run` — Expected: whole suite PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/approve.ts test/unit/approve-delivery.test.ts
git commit -m "feat(cli): fail-closed delivery gate (clean tree + passing verify for HEAD)"
```

---

### Task 11: Attestation builder (in-toto statement + signed envelope)

**Files:**
- Create: `src/core/attestation.ts`
- Test: `test/unit/attestation.test.ts`

**Interfaces:**
- Consumes: config, ledger, dsse, encoding, git.
- Produces:
  - `const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1'`, `const PREDICATE_TYPE = 'https://omeryasironal.com/akis-attest/predicate/v1'`, `const PAYLOAD_TYPE = 'application/vnd.in-toto+json'`
  - `interface InTotoStatement { _type: string; subject: Array<{ name: string; digest: Record<string, string> }>; predicateType: string; predicate: { gates: { plan: { ts: string; actor: string; message: string }; verify: Record<string, unknown>; delivery: { ts: string; actor: string; message: string } }; ledger: { root: string; length: number }; tool: { name: string; version: string } } }`
  - `buildStatement(cwd: string): InTotoStatement` — reads config + ledger; throws `Error('gates incomplete: ...')` naming the missing gate(s) when there is no `approve_plan` or no `approve_delivery`. Subject: always `{ name: project, digest: { gitCommit: deliverySha } }`; plus one `{ name: relPath, digest: { sha256 } }` per `config.artifacts` path (exact relative file paths, v1 — no globs).
  - `writeAttestation(cwd: string): { statement: InTotoStatement; envelope: DsseEnvelope }` — writes `.attest/attestation.json` (pretty statement) and `.attest/envelope.json`; payload bytes = UTF-8 of `canonicalJson(statement)`.

- [ ] **Step 1: Write the failing test**

`test/unit/attestation.test.ts`:
```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runApprove } from '../../src/commands/approve.js'
import { runInit } from '../../src/commands/init.js'
import { runVerify } from '../../src/commands/verify.js'
import { buildStatement, writeAttestation } from '../../src/core/attestation.js'
import { loadConfig, saveConfig } from '../../src/core/config.js'
import { verifyEnvelope } from '../../src/core/dsse.js'
import { execFileSync } from 'node:child_process'
import { fixtureRepo, tmpDir } from '../helpers.js'

async function deliveredRepo(): Promise<string> {
  process.env.AKIS_ATTEST_HOME = tmpDir()
  const repo = fixtureRepo()
  runInit(['--project', 'demo', '--test-command', 'echo "Tests  1 passed (1)"'], repo)
  const cfg = loadConfig(repo)
  saveConfig(repo, { ...cfg, artifacts: ['app.txt'] })
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'attest setup'], { cwd: repo })
  runApprove(['plan', '-m', 'scope'], repo)
  await runVerify([], repo)
  runApprove(['delivery', '-m', 'ship it'], repo)
  return repo
}

describe('attestation', () => {
  it('builds a statement with git subject, artifact digest and gate chain', async () => {
    const repo = await deliveredRepo()
    const st = buildStatement(repo)
    expect(st._type).toBe('https://in-toto.io/Statement/v1')
    expect(st.subject[0]!.digest.gitCommit).toMatch(/^[0-9a-f]{40}$/)
    expect(st.subject[1]).toMatchObject({ name: 'app.txt' })
    expect(st.predicate.gates.plan.message).toBe('scope')
    expect(st.predicate.gates.delivery.message).toBe('ship it')
    expect(st.predicate.ledger.root).toMatch(/^[0-9a-f]{64}$/)
  })
  it('writes a DSSE envelope that verifies', async () => {
    const repo = await deliveredRepo()
    const { envelope } = writeAttestation(repo)
    expect(verifyEnvelope(envelope)).toBe(true)
  })
  it('throws when gates are incomplete', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit([], repo)
    expect(() => buildStatement(repo)).toThrow(/gates incomplete/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/attestation.test.ts`
Expected: FAIL — cannot find module `src/core/attestation.js`.

- [ ] **Step 3: Write minimal implementation**

`src/core/attestation.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attestDir, loadConfig } from './config.js'
import { canonicalJson, sha256Hex } from './encoding.js'
import { signEnvelope, type DsseEnvelope } from './dsse.js'
import { readLedger, type LedgerEvent } from './ledger.js'

export const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1'
export const PREDICATE_TYPE = 'https://omeryasironal.com/akis-attest/predicate/v1'
export const PAYLOAD_TYPE = 'application/vnd.in-toto+json'
const TOOL_VERSION = '0.1.0'

export interface InTotoStatement {
  _type: string
  subject: Array<{ name: string; digest: Record<string, string> }>
  predicateType: string
  predicate: {
    gates: {
      plan: { ts: string; actor: string; message: string }
      verify: Record<string, unknown>
      delivery: { ts: string; actor: string; message: string }
    }
    ledger: { root: string; length: number }
    tool: { name: string; version: string }
  }
}

function lastOf(events: LedgerEvent[], kind: LedgerEvent['kind']): LedgerEvent | undefined {
  return [...events].reverse().find((e) => e.kind === kind)
}

export function buildStatement(cwd: string): InTotoStatement {
  const cfg = loadConfig(cwd)
  const events = readLedger(attestDir(cwd))
  const plan = lastOf(events, 'approve_plan')
  const delivery = lastOf(events, 'approve_delivery')
  const missing = [!plan && 'plan approval', !delivery && 'delivery approval'].filter(Boolean)
  if (!plan || !delivery) throw new Error(`gates incomplete: missing ${missing.join(', ')}`)
  const verifySeq = delivery.payload.verifySeq as number
  const verifyEvent = events.find((e) => e.seq === verifySeq)
  if (!verifyEvent) throw new Error('gates incomplete: delivery references a missing verify event')
  const last = events[events.length - 1]!
  const subject: InTotoStatement['subject'] = [
    { name: cfg.project, digest: { gitCommit: delivery.gitSha } },
    ...(cfg.artifacts ?? []).map((rel) => ({
      name: rel,
      digest: { sha256: sha256Hex(readFileSync(join(cwd, rel))) },
    })),
  ]
  return {
    _type: STATEMENT_TYPE,
    subject,
    predicateType: PREDICATE_TYPE,
    predicate: {
      gates: {
        plan: { ts: plan.ts, actor: plan.actor, message: String(plan.payload.message) },
        verify: { ts: verifyEvent.ts, actor: verifyEvent.actor, ...verifyEvent.payload },
        delivery: { ts: delivery.ts, actor: delivery.actor, message: String(delivery.payload.message) },
      },
      ledger: { root: last.hash, length: events.length },
      tool: { name: 'akis-attest', version: TOOL_VERSION },
    },
  }
}

export function writeAttestation(cwd: string): { statement: InTotoStatement; envelope: DsseEnvelope } {
  const statement = buildStatement(cwd)
  const envelope = signEnvelope(PAYLOAD_TYPE, new TextEncoder().encode(canonicalJson(statement)))
  const dir = attestDir(cwd)
  writeFileSync(join(dir, 'attestation.json'), JSON.stringify(statement, null, 2) + '\n')
  writeFileSync(join(dir, 'envelope.json'), JSON.stringify(envelope, null, 2) + '\n')
  return { statement, envelope }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/attestation.test.ts` — Expected: PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/core/attestation.ts test/unit/attestation.test.ts
git commit -m "feat(core): in-toto statement + signed DSSE attestation from the ledger"
```

---

### Task 12: Proof page + `attest export`

**Files:**
- Create: `src/page/i18n.ts`, `src/page/template.ts`, `src/commands/export.ts`
- Modify: `src/cli.ts` (wire `case 'export'`)
- Test: `test/unit/export.test.ts`

**Interfaces:**
- Consumes: attestation (Task 11), ledger, config.
- Produces:
  - `interface ProofBundle { schema: 'akis-attest/proof-bundle/v1'; project: string; lang: 'en' | 'tr'; generatedAt: string; draft: boolean; envelope: DsseEnvelope | null; ledger: LedgerEvent[] }`
  - `renderProofPage(bundle: ProofBundle): string` — full HTML document. The bundle is embedded as `<script id="attest-bundle" type="application/json">…</script>` with `<` escaped as `<`. Inline JS (no external requests): base64 → bytes, DSSE PAE, `crypto.subtle.importKey('spki', …, { name: 'Ed25519' })` + `crypto.subtle.verify`, AND a browser re-implementation of canonical JSON + SHA-256 chain walk over the embedded ledger. Sets `document.body.dataset.verifyState` to `ok` | `fail` | `unsupported` | `draft`. Shows: project, delivery message, gate timeline, test numbers/duration/env fingerprint, key fingerprint (prominent, with "compare out-of-band" note), the honesty box, `attest check` instructions, EN/TR toggle (all translatable nodes carry `data-i18n="key"`), light/dark via `prefers-color-scheme`, and a fixed `DRAFT — UNSIGNED` banner when `draft` is true.
  - `runExport(argv: string[], cwd: string): number` — flags `--draft`, `--out <path>` (default `proof.html` in cwd). Without `--draft`: calls `writeAttestation` (which throws `gates incomplete` → exit 1 with the message). With `--draft`: `envelope: null`, no signing, page shows the draft banner.
  - Honesty box copy (verbatim, EN; TR mirror in the catalog):
    - Proves: "This ledger was produced by the holder of the key whose fingerprint is shown above, and has not been modified since signing." / "The recorded test command really ran and exited with the recorded result." / "Each approval was recorded at the stated time against the stated git commit."
    - Does NOT prove: "That the key holder is who they claim to be — compare the fingerprint through a channel you trust." / "That the tests are meaningful or complete." / "Any third-party or independent endorsement (v1 signatures are self-issued)."

- [ ] **Step 1: Write the failing test**

`test/unit/export.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { runApprove } from '../../src/commands/approve.js'
import { runExport } from '../../src/commands/export.js'
import { runInit } from '../../src/commands/init.js'
import { runVerify } from '../../src/commands/verify.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

async function deliveredRepo(): Promise<string> {
  process.env.AKIS_ATTEST_HOME = tmpDir()
  const repo = fixtureRepo()
  runInit(['--project', 'demo', '--test-command', 'echo "Tests  1 passed (1)"'], repo)
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'setup'], { cwd: repo })
  runApprove(['plan', '-m', 'scope'], repo)
  await runVerify([], repo)
  runApprove(['delivery', '-m', 'ship'], repo)
  return repo
}

describe('attest export', () => {
  it('writes a self-contained proof.html embedding the signed bundle', async () => {
    const repo = await deliveredRepo()
    expect(runExport([], repo)).toBe(0)
    const html = readFileSync(join(repo, 'proof.html'), 'utf8')
    expect(html).toContain('id="attest-bundle"')
    const embedded = /<script id="attest-bundle" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!
    const bundle = JSON.parse(embedded[1]!)
    expect(bundle.schema).toBe('akis-attest/proof-bundle/v1')
    expect(bundle.envelope.signatures[0].sig.length).toBeGreaterThan(10)
    expect(bundle.draft).toBe(false)
    expect(html).not.toContain('src="http')
  })
  it('refuses full export before delivery, allows --draft with null envelope', async () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit([], repo)
    expect(runExport([], repo)).toBe(1)
    expect(runExport(['--draft'], repo)).toBe(0)
    const html = readFileSync(join(repo, 'proof.html'), 'utf8')
    const bundle = JSON.parse(/<script id="attest-bundle" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!)
    expect(bundle.draft).toBe(true)
    expect(bundle.envelope).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/export.test.ts`
Expected: FAIL — cannot find module `src/commands/export.js`.

- [ ] **Step 3: Write the implementation**

`src/page/i18n.ts`:
```ts
export type Lang = 'en' | 'tr'

export const STRINGS: Record<string, { en: string; tr: string }> = {
  title: { en: 'Delivery proof', tr: 'Teslimat kanıtı' },
  verifying: { en: 'Verifying in your browser…', tr: 'Tarayıcınızda doğrulanıyor…' },
  verified: { en: 'Signature and ledger verified in your browser', tr: 'İmza ve defter tarayıcınızda doğrulandı' },
  failed: { en: 'VERIFICATION FAILED — do not trust this page', tr: 'DOĞRULAMA BAŞARISIZ — bu sayfaya güvenmeyin' },
  unsupported: { en: 'Your browser cannot verify Ed25519 — use the CLI check below', tr: 'Tarayıcınız Ed25519 doğrulayamıyor — aşağıdaki CLI kontrolünü kullanın' },
  draft: { en: 'DRAFT — GATES INCOMPLETE, UNSIGNED', tr: 'TASLAK — KAPILAR TAMAMLANMADI, İMZASIZ' },
  gates: { en: 'Approval gates', tr: 'Onay kapıları' },
  gatePlan: { en: 'Plan approved', tr: 'Plan onaylandı' },
  gateVerify: { en: 'Tests really ran', tr: 'Testler gerçekten koştu' },
  gateDelivery: { en: 'Delivery approved', tr: 'Teslimat onaylandı' },
  tests: { en: 'Test run', tr: 'Test koşumu' },
  env: { en: 'Environment', tr: 'Ortam' },
  fingerprint: { en: 'Signer key fingerprint', tr: 'İmzacı anahtar parmak izi' },
  fingerprintNote: {
    en: 'Compare this fingerprint with the one your contractor gave you through another channel.',
    tr: 'Bu parmak izini, yükleniciden başka bir kanaldan aldığınız parmak iziyle karşılaştırın.',
  },
  honestyTitle: { en: 'What this proves — and what it does not', tr: 'Bu neyi kanıtlar — neyi kanıtlamaz' },
  proves1: { en: 'This ledger was produced by the holder of the key whose fingerprint is shown above, and has not been modified since signing.', tr: 'Bu defter, yukarıdaki parmak izine sahip anahtarın sahibince üretildi ve imzadan sonra değiştirilmedi.' },
  proves2: { en: 'The recorded test command really ran and exited with the recorded result.', tr: 'Kayıtlı test komutu gerçekten çalıştı ve kayıtlı sonuçla tamamlandı.' },
  proves3: { en: 'Each approval was recorded at the stated time against the stated git commit.', tr: 'Her onay, belirtilen zamanda ve belirtilen git commit\'ine karşı kaydedildi.' },
  not1: { en: 'That the key holder is who they claim to be — compare the fingerprint through a channel you trust.', tr: 'Anahtar sahibinin iddia ettiği kişi olduğunu — parmak izini güvendiğiniz bir kanaldan karşılaştırın.' },
  not2: { en: 'That the tests are meaningful or complete.', tr: 'Testlerin anlamlı veya eksiksiz olduğunu.' },
  not3: { en: 'Any third-party or independent endorsement (v1 signatures are self-issued).', tr: 'Herhangi bir üçüncü taraf veya bağımsız onayı (v1 imzaları öz-imzalıdır).' },
  checkTitle: { en: 'Verify independently', tr: 'Bağımsız doğrulayın' },
  checkBody: { en: 'Skeptical? Run this against this very file:', tr: 'Şüpheci misiniz? Bu komutu bu dosyanın kendisi üzerinde çalıştırın:' },
}

export function catalogFor(lang: Lang): Record<string, string> {
  return Object.fromEntries(Object.entries(STRINGS).map(([k, v]) => [k, v[lang]]))
}
```

`src/page/template.ts` (single exported function; template literal HTML; the inline script re-implements canonicalJson + PAE in browser JS and uses `crypto.subtle` for both SHA-256 chain walk and Ed25519 verify):
```ts
import type { DsseEnvelope } from '../core/dsse.js'
import type { LedgerEvent } from '../core/ledger.js'
import { STRINGS } from './i18n.js'

export interface ProofBundle {
  schema: 'akis-attest/proof-bundle/v1'
  project: string
  lang: 'en' | 'tr'
  generatedAt: string
  draft: boolean
  envelope: DsseEnvelope | null
  ledger: LedgerEvent[]
}

export function renderProofPage(bundle: ProofBundle): string {
  const json = JSON.stringify(bundle).replaceAll('<', '\\u003c')
  const i18nJson = JSON.stringify(STRINGS).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="${bundle.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>akis-attest — ${escapeHtml(bundle.project)}</title>
<style>
:root { color-scheme: light dark; --ok:#1a7f37; --fail:#b91c1c; --warn:#b45309; --muted:#6b7280; }
body { font: 16px/1.55 system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
.badge { padding: .6rem 1rem; border-radius: .5rem; font-weight: 600; }
body[data-verify-state="ok"] .badge { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
body[data-verify-state="fail"] .badge { background: color-mix(in srgb, var(--fail) 12%, transparent); color: var(--fail); }
body[data-verify-state="unsupported"] .badge, body[data-verify-state="draft"] .badge { background: color-mix(in srgb, var(--warn) 12%, transparent); color: var(--warn); }
.draft-banner { position: sticky; top: 0; background: var(--warn); color: white; text-align: center; padding: .4rem; font-weight: 700; }
table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: .3rem .6rem 0; vertical-align: top; }
code, .mono { font-family: ui-monospace, monospace; font-size: .85em; word-break: break-all; }
.box { border: 1px solid var(--muted); border-radius: .5rem; padding: .8rem 1rem; margin: 1rem 0; }
.muted { color: var(--muted); } button { cursor: pointer; }
</style>
</head>
<body data-verify-state="${bundle.draft ? 'draft' : 'pending'}">
${bundle.draft ? '<div class="draft-banner" data-i18n="draft"></div>' : ''}
<header>
  <button id="lang-toggle">EN / TR</button>
  <h1>${escapeHtml(bundle.project)} — <span data-i18n="title"></span></h1>
  <p class="badge" id="badge" data-i18n="verifying"></p>
</header>
<main>
  <section><h2 data-i18n="gates"></h2><div id="gates"></div></section>
  <section><h2 data-i18n="tests"></h2><div id="tests"></div></section>
  <section><h2 data-i18n="fingerprint"></h2>
    <p class="mono" id="fingerprint"></p><p class="muted" data-i18n="fingerprintNote"></p></section>
  <section class="box"><h2 data-i18n="honestyTitle"></h2>
    <ul><li data-i18n="proves1"></li><li data-i18n="proves2"></li><li data-i18n="proves3"></li></ul>
    <ul class="muted"><li data-i18n="not1"></li><li data-i18n="not2"></li><li data-i18n="not3"></li></ul></section>
  <section><h2 data-i18n="checkTitle"></h2><p data-i18n="checkBody"></p>
    <pre><code>npx akis-attest check proof.html</code></pre></section>
</main>
<script id="attest-bundle" type="application/json">${json}</script>
<script id="attest-i18n" type="application/json">${i18nJson}</script>
<script>
const bundle = JSON.parse(document.getElementById('attest-bundle').textContent)
const STRINGS = JSON.parse(document.getElementById('attest-i18n').textContent)
let lang = bundle.lang
function applyI18n() {
  document.documentElement.lang = lang
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = STRINGS[el.dataset.i18n][lang]
  const badge = document.getElementById('badge')
  const state = document.body.dataset.verifyState
  const key = { ok: 'verified', fail: 'failed', unsupported: 'unsupported', draft: 'draft', pending: 'verifying' }[state]
  badge.dataset.i18n = key
  badge.textContent = STRINGS[key][lang]
}
document.getElementById('lang-toggle').addEventListener('click', () => { lang = lang === 'en' ? 'tr' : 'en'; applyI18n() })

const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
function canonicalJson(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function pae(type, payload) {
  const t = new TextEncoder().encode(type)
  const h = new TextEncoder().encode('DSSEv1 ' + t.length + ' ' + type + ' ' + payload.length + ' ')
  const out = new Uint8Array(h.length + payload.length); out.set(h); out.set(payload, h.length); return out
}
async function verifyChain(events) {
  let prev = '0'.repeat(64)
  for (const e of events) {
    const { hash, ...rest } = e
    if (e.prevHash !== prev) return false
    if (await sha256Hex(canonicalJson(rest)) !== hash) return false
    prev = hash
  }
  return true
}
async function verifyAll() {
  if (bundle.draft) { document.body.dataset.verifyState = 'draft'; applyI18n(); render(); return }
  try {
    const sig = bundle.envelope.signatures[0]
    const key = await crypto.subtle.importKey('spki', b64(sig.publicKeySpki), { name: 'Ed25519' }, false, ['verify'])
    const payload = b64(bundle.envelope.payload)
    const sigOk = await crypto.subtle.verify('Ed25519', key, b64(sig.sig), pae(bundle.envelope.payloadType, payload))
    const statement = JSON.parse(new TextDecoder().decode(payload))
    const chainOk = await verifyChain(bundle.ledger)
    const rootOk = bundle.ledger.length > 0 && statement.predicate.ledger.root === bundle.ledger[bundle.ledger.length - 1].hash
    document.body.dataset.verifyState = sigOk && chainOk && rootOk ? 'ok' : 'fail'
    document.getElementById('fingerprint').textContent = sig.keyid
    render(statement)
  } catch (e) {
    document.body.dataset.verifyState = 'unsupported'
  }
  applyI18n()
}
function render(statement) {
  const gates = document.getElementById('gates')
  const rows = []
  for (const e of bundle.ledger) {
    if (e.kind === 'approve_plan') rows.push([STRINGS.gatePlan[lang], e.ts, e.actor, e.payload.message ?? ''])
    if (e.kind === 'verify') rows.push([STRINGS.gateVerify[lang], e.ts, e.actor, e.payload.pass ? 'PASS' : 'FAIL'])
    if (e.kind === 'approve_delivery') rows.push([STRINGS.gateDelivery[lang], e.ts, e.actor, e.payload.message ?? ''])
  }
  gates.innerHTML = '<table>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + String(c).replace(/</g, '&lt;') + '</td>').join('') + '</tr>').join('') + '</table>'
  if (statement) {
    const v = statement.predicate.gates.verify
    document.getElementById('tests').innerHTML =
      '<p><code>' + String(v.command).replace(/</g, '&lt;') + '</code> — ' +
      (v.tests === 'unparsed' ? 'exit ' + v.exitCode : v.tests.passed + ' passed, ' + v.tests.failed + ' failed') +
      ' (' + v.durationMs + 'ms, node ' + v.env.node + ', ' + v.env.platform + ')</p>'
  }
}
applyI18n(); verifyAll()
</script>
</body>
</html>
`
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
```

`src/commands/export.ts`:
```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { writeAttestation } from '../core/attestation.js'
import { attestDir, loadConfig } from '../core/config.js'
import { readLedger } from '../core/ledger.js'
import { renderProofPage, type ProofBundle } from '../page/template.js'

export function runExport(argv: string[], cwd: string): number {
  const { values } = parseArgs({
    args: argv,
    options: { draft: { type: 'boolean', default: false }, out: { type: 'string', default: 'proof.html' } },
  })
  const cfg = loadConfig(cwd)
  let envelope: ProofBundle['envelope'] = null
  if (!values.draft) {
    try {
      envelope = writeAttestation(cwd).envelope
    } catch (e) {
      console.error(`error: ${(e as Error).message} — complete the gates or use --draft`)
      return 1
    }
  }
  const bundle: ProofBundle = {
    schema: 'akis-attest/proof-bundle/v1',
    project: cfg.project,
    lang: cfg.lang ?? 'en',
    generatedAt: new Date().toISOString(),
    draft: values.draft === true,
    envelope,
    ledger: readLedger(attestDir(cwd)),
  }
  const outPath = join(cwd, values.out ?? 'proof.html')
  writeFileSync(outPath, renderProofPage(bundle))
  console.log(`${values.draft ? 'DRAFT proof' : 'proof'} written to ${outPath}`)
  return 0
}
```

Wire in `src/cli.ts`: `case 'export': return runExport(rest, process.cwd())` (add the import).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/export.test.ts` — Expected: PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/page/i18n.ts src/page/template.ts src/commands/export.ts src/cli.ts test/unit/export.test.ts
git commit -m "feat(cli): attest export — self-verifying EN/TR proof.html with honesty box"
```

---

### Task 13: `attest check` (offline verifier)

**Files:**
- Create: `src/commands/check.ts`
- Modify: `src/cli.ts` (wire `case 'check'`)
- Test: `test/unit/check.test.ts`

**Interfaces:**
- Consumes: ledger `verifyChain`, dsse `verifyEnvelope`, encoding.
- Produces: `runCheck(argv: string[], cwd: string): number`.
  - No positional arg → checks the repo's `.attest/` (chain always; envelope + ledger-root match when `envelope.json` exists).
  - Positional arg ending in `.html` → extracts the bundle via `/<script id="attest-bundle" type="application\/json">([\s\S]*?)<\/script>/`, then checks chain + envelope + `statement.predicate.ledger.root === last event hash`. Draft bundles report `DRAFT (unsigned)` and exit 1.
  - Prints one line per check: `chain: OK|FAIL…`, `signature: OK|FAIL|absent`, `root: OK|FAIL`. Exit 0 only when everything verifiable passed and a signature was present.

- [ ] **Step 1: Write the failing test**

`test/unit/check.test.ts`:
```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { runApprove } from '../../src/commands/approve.js'
import { runCheck } from '../../src/commands/check.js'
import { runExport } from '../../src/commands/export.js'
import { runInit } from '../../src/commands/init.js'
import { runVerify } from '../../src/commands/verify.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

async function exportedRepo(): Promise<string> {
  process.env.AKIS_ATTEST_HOME = tmpDir()
  const repo = fixtureRepo()
  runInit(['--test-command', 'echo "Tests  1 passed (1)"'], repo)
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-m', 'setup'], { cwd: repo })
  runApprove(['plan', '-m', 'scope'], repo)
  await runVerify([], repo)
  runApprove(['delivery', '-m', 'ship'], repo)
  runExport([], repo)
  return repo
}

describe('attest check', () => {
  it('passes on an intact repo and on the exported proof.html', async () => {
    const repo = await exportedRepo()
    expect(runCheck([], repo)).toBe(0)
    expect(runCheck([join(repo, 'proof.html')], repo)).toBe(0)
  })
  it('fails on a tampered proof.html', async () => {
    const repo = await exportedRepo()
    const path = join(repo, 'proof.html')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"message":"ship"', '"message":"HACK"'))
    expect(runCheck([path], repo)).toBe(1)
  })
  it('fails (exit 1) on a repo without a signature', () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    runInit([], repo)
    expect(runCheck([], repo)).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/check.test.ts`
Expected: FAIL — cannot find module `src/commands/check.js`.

- [ ] **Step 3: Write minimal implementation**

`src/commands/check.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { attestDir } from '../core/config.js'
import { verifyEnvelope, type DsseEnvelope } from '../core/dsse.js'
import { fromBase64 } from '../core/encoding.js'
import { verifyChain, type LedgerEvent } from '../core/ledger.js'

interface Checkable {
  ledger: LedgerEvent[]
  envelope: DsseEnvelope | null
}

function fromRepo(cwd: string): Checkable {
  const dir = attestDir(cwd)
  const ledgerPath = join(dir, 'ledger.jsonl')
  const envPath = join(dir, 'envelope.json')
  const ledger = existsSync(ledgerPath)
    ? readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerEvent)
    : []
  const envelope = existsSync(envPath) ? (JSON.parse(readFileSync(envPath, 'utf8')) as DsseEnvelope) : null
  return { ledger, envelope }
}

function fromHtml(path: string): Checkable {
  const html = readFileSync(path, 'utf8')
  const match = /<script id="attest-bundle" type="application\/json">([\s\S]*?)<\/script>/.exec(html)
  if (!match) throw new Error('no embedded attest bundle found in this file')
  const bundle = JSON.parse(match[1]!) as { ledger: LedgerEvent[]; envelope: DsseEnvelope | null }
  return { ledger: bundle.ledger, envelope: bundle.envelope }
}

export function runCheck(argv: string[], cwd: string): number {
  const target = argv[0]
  let subject: Checkable
  try {
    subject = target !== undefined && target.endsWith('.html') ? fromHtml(target) : fromRepo(cwd)
  } catch (e) {
    console.error(`error: ${(e as Error).message}`)
    return 1
  }
  let ok = true
  const chain = verifyChain(subject.ledger)
  console.log(chain.ok ? 'chain: OK' : `chain: FAIL at seq ${chain.brokenAtSeq} (${chain.reason})`)
  if (!chain.ok) ok = false
  if (subject.envelope === null) {
    console.log('signature: absent (draft or not exported)')
    ok = false
  } else {
    const sigOk = verifyEnvelope(subject.envelope)
    console.log(sigOk ? 'signature: OK' : 'signature: FAIL')
    if (!sigOk) ok = false
    const statement = JSON.parse(fromBase64(subject.envelope.payload).toString('utf8')) as {
      predicate: { ledger: { root: string } }
    }
    const last = subject.ledger[subject.ledger.length - 1]
    const rootOk = last !== undefined && statement.predicate.ledger.root === last.hash
    console.log(rootOk ? 'root: OK' : 'root: FAIL (attestation does not match this ledger)')
    if (!rootOk) ok = false
  }
  console.log(ok ? 'PASS' : 'FAIL')
  return ok ? 0 : 1
}
```

Wire in `src/cli.ts`: `case 'check': return runCheck(rest, process.cwd())` (add the import).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/check.test.ts` — Expected: PASS.
Run: `pnpm vitest run` — Expected: FULL suite PASS. `pnpm typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add src/commands/check.ts src/cli.ts test/unit/check.test.ts
git commit -m "feat(cli): attest check — offline chain+signature+root verification, works on proof.html"
```

---

### Task 14: Integration flow test + browser E2E + CI

**Files:**
- Create: `test/integration/flow.test.ts`, `e2e/proof.spec.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: everything above; drives the CLI through `main()` (Task 7) instead of per-command functions.

- [ ] **Step 1: Write the integration test**

`test/integration/flow.test.ts`:
```ts
import { execFileSync } from 'node:child_process'
import { existsSync, join as _join } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { main } from '../../src/cli.js'
import { fixtureRepo, tmpDir } from '../helpers.js'

describe('full flow via CLI dispatch', () => {
  it('init → approve plan → verify → approve delivery → export → check', async () => {
    process.env.AKIS_ATTEST_HOME = tmpDir()
    const repo = fixtureRepo()
    const cwd = process.cwd()
    process.chdir(repo)
    try {
      expect(await main(['init', '--project', 'flow', '--test-command', 'echo "Tests  1 passed (1)"'])).toBe(0)
      execFileSync('git', ['add', '-A'], { cwd: repo })
      execFileSync('git', ['commit', '-m', 'attest setup'], { cwd: repo })
      expect(await main(['approve', 'plan', '-m', 'scope'])).toBe(0)
      expect(await main(['verify'])).toBe(0)
      expect(await main(['approve', 'delivery', '-m', 'ship'])).toBe(0)
      expect(await main(['export'])).toBe(0)
      expect(await main(['check', join(repo, 'proof.html')])).toBe(0)
      expect(await main(['bogus'])).toBe(2)
    } finally {
      process.chdir(cwd)
    }
  })
})
```

Run: `pnpm vitest run test/integration/flow.test.ts` — Expected: PASS immediately (all parts exist; this is a regression net, commit it once green). If it fails, fix the dispatch before continuing.

- [ ] **Step 2: Write the browser E2E**

`playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  use: { browserName: 'chromium' },
})
```

`e2e/proof.spec.ts`:
```ts
import { execFileSync, execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

function buildProof(): string {
  const home = mkdtempSync(join(tmpdir(), 'attest-home-'))
  const repo = mkdtempSync(join(tmpdir(), 'attest-e2e-'))
  const env = { ...process.env, AKIS_ATTEST_HOME: home }
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo })
  git('init', '-b', 'main')
  git('config', 'user.name', 'E2E')
  git('config', 'user.email', 'e2e@test')
  writeFileSync(join(repo, 'app.txt'), 'hello')
  git('add', '-A')
  git('commit', '-m', 'initial')
  const attest = (args: string) =>
    execSync(`pnpm exec tsx ${join(process.cwd(), 'src/cli.ts')} ${args}`, { cwd: repo, env })
  attest('init --project e2e --test-command "echo \\"Tests  1 passed (1)\\""')
  git('add', '-A')
  git('commit', '-m', 'attest setup')
  attest('approve plan -m scope')
  attest('verify')
  attest('approve delivery -m ship')
  attest('export')
  return join(repo, 'proof.html')
}

test('proof.html verifies itself in a real browser', async ({ page }) => {
  const proofPath = buildProof()
  await page.goto(`file://${proofPath}`)
  await expect(page.locator('body')).toHaveAttribute('data-verify-state', 'ok', { timeout: 10_000 })
  await page.click('#lang-toggle')
  await expect(page.locator('h1')).toContainText('Teslimat kanıtı')
})

test('a tampered proof.html fails in the browser', async ({ page }) => {
  const proofPath = buildProof()
  const tampered = proofPath.replace('proof.html', 'tampered.html')
  writeFileSync(tampered, readFileSync(proofPath, 'utf8').replace('"message":"ship"', '"message":"HACK"'))
  await page.goto(`file://${tampered}`)
  await expect(page.locator('body')).toHaveAttribute('data-verify-state', 'fail', { timeout: 10_000 })
})
```

- [ ] **Step 3: Run the E2E**

Run: `pnpm exec playwright install chromium` (first time), then `pnpm e2e`
Expected: 2 tests PASS. If `data-verify-state` never leaves `pending`, debug the inline script with `page.on('console')` — the most likely cause is Ed25519 unsupported in the installed Chromium (then the state is `unsupported`, which is a REAL finding: fix by documenting the fallback, not by faking the badge).

- [ ] **Step 4: Add CI**

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm exec playwright install chromium --with-deps
      - run: pnpm e2e
      - run: pnpm build
```

- [ ] **Step 5: Full local gate + commit**

Run: `pnpm typecheck && pnpm test && pnpm e2e && pnpm build`
Expected: all green; `dist/cli.js` exists.

```bash
git add test/integration/flow.test.ts e2e/proof.spec.ts playwright.config.ts .github/workflows/ci.yml
git commit -m "test: full-flow integration + browser E2E (verify + tamper) + CI"
```

---

### Task 15: README + dogfood + owner-gated publication

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md (EN, product voice — not thesis voice)**

Required sections, in order:
1. One-liner (verbatim): *Ship AI-built work with proof: human-approved gates, really-run tests, a signed attestation, one shareable link.*
2. `Why` — 3 sentences max: clients don't trust AI-built deliveries; this records what was approved, what really ran, and signs it; the proof is one static HTML file.
3. `Quickstart` — the exact six-command flow from Task 14's integration test, as a copy-paste block.
4. `What the proof means` — the honesty box content (both lists, EN), verbatim from Task 12.
5. `Threat model in one paragraph` — v1 signatures are self-issued (key fingerprint must be compared out-of-band); the ledger detects tampering, not intent; Sigstore/CI countersigning is the planned v1.1 independent root.
6. `Development` — pnpm install / test / e2e / build.

- [ ] **Step 2: Verify docs match reality**

Run every command in the Quickstart block inside a scratch repo, exactly as written. Expected: works verbatim. Fix the README (or the CLI) if not.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README with quickstart, honesty box, one-paragraph threat model"
```

- [ ] **Step 4: OWNER-GATED (do not execute without explicit owner approval)**

- `gh repo create OmerYasirOnal/akis-attest --private --source . --push` (private first; public is the owner's call — spec §7).
- npm name availability: `npm view akis-attest` (404 = free). Publishing is owner-gated.
- Dogfood #1: run the six-command flow in a real portfolio/freelance repo; deploy `proof.html`; link from omeryasironal.com.
- Dogfood #2 (meta-showcase): attest an `akis` release.

---

## Self-Review (completed at plan time)

1. **Spec coverage:** ledger+3 gates (§4.1 → Tasks 3/8/9/10), attestation subject default git-SHA + optional artifact paths (§4.1 → Task 11), signature honesty labeling (§4.1 → Task 12 honesty box `not3`), CLI 6 commands + draft watermark + fail-closed export (§4.2 → Tasks 7-13), proof page single-file/EN+TR/self-verifying/honesty box/check instructions (§4.3 → Task 12, E2E Task 14), error table (§5 → dirty/no-verify in Task 10 tests, tamper in Tasks 3/13/14, unparsed in Task 9, non-git in Task 7, key-loss documented in README Task 15), TDD+fixture+browser-E2E (§6 → every task + Task 14), dogfood (§7 → Task 15), open questions resolved: npm-name check in Task 15, reporter adapters = one generic regex pair v1 (Task 9), artifacts = exact paths v1 (Task 11), page visual polish deliberately minimal in v1 (functional page; design-language pass is post-v1). Sigstore/Action/portal correctly absent (spec §3).
2. **Placeholder scan:** none — every step has complete code or an exact command with expected output.
3. **Type consistency:** `run*(argv, cwd)` signature uniform; `LedgerEvent`/`AttestConfig`/`DsseEnvelope`/`TestRunResult`/`ProofBundle` field names identical across Tasks 3-13; `verifySeq` written in Task 10 and consumed in Task 11; `data-verify-state` values identical between template (Task 12) and E2E (Task 14).
