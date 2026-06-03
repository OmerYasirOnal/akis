import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BuildPassport } from '@akis/shared'

/**
 * The signed Build Passport — AKIS's "portable trust" artifact (sign/verify + key handling).
 *
 * It turns AKIS's in-process verification (the branded, fail-closed VerifyToken) into a
 * DURABLE, third-party-verifiable proof. On a verified build the orchestrator produces a
 * {@link BuildPassport} (the wire type lives in @akis/shared) that ASYMMETRICALLY signs
 * (Ed25519, node:crypto — NO new dependency) the ALREADY-MINTED facts the VerifyToken
 * carries: { sessionId, testsRun, codeDigest, evidenceDigest, issuedAt }. Anyone holding
 * the public key can {@link verifyPassport} it OFFLINE — without trusting AKIS, the
 * network, or replaying the build.
 *
 * TRUST SEAM (the branded-token design is the boundary): the passport ATTESTS facts that
 * were already earned through the gates — it can NEVER mint or forge verification. The
 * orchestrator holds the PRIVATE key and can therefore only SIGN already-verified facts;
 * a verifier (or a third party) holds only the PUBLIC key and can only TRUST (check a
 * signature). The private key signs; it never grants verification.
 */
export type { BuildPassport }

/** The already-minted, verified facts a passport attests (mirrors the VerifyToken). The
 *  passport SIGNS these — it cannot produce them; only a genuine VerifyToken can. */
export interface PassportFacts {
  sessionId: string
  testsRun: number
  codeDigest: string
  evidenceDigest: string
}

/**
 * A passport signer — holds the Ed25519 PRIVATE key (to sign) and exposes the PUBLIC key.
 * The private key is a node:crypto `KeyObject`: even if the signer is accidentally
 * JSON.stringify'd or logged, a KeyObject serializes to `{}` (no key material), so the raw
 * key bytes never leak — and the route returns only `publicKey`. `dev` flags a generated/dev
 * keypair (vs. an operator-supplied one from env) so a boot can surface it honestly.
 */
export interface PassportSigner {
  /** SPKI public key (PEM). Safe to publish/return. */
  readonly publicKey: string
  /** True when this is a generated DEV keypair (no AKIS_PASSPORT_PRIVATE_KEY configured). */
  readonly dev: boolean
  /** The Ed25519 private key as a node:crypto `KeyObject` (an in-realm holder can sign with it,
   *  but it serializes to `{}` — no raw key bytes — and is never logged or returned). Used only
   *  by `signPassport` in this module. */
  readonly privateKeyObject: KeyObject
}

/** A keypair as PEM strings — `generatePassportKeypair`'s output and the seed for env config. */
export interface PassportKeypair {
  /** SPKI public key (PEM). */
  readonly publicKey: string
  /** PKCS#8 private key (PEM). For env config (AKIS_PASSPORT_PRIVATE_KEY) — NEVER log it. */
  readonly privateKey: string
}

/** Length-prefixed canonical bytes the signature covers — injective over the facts +
 *  issuedAt (no separator ambiguity), so a payload cannot be re-parsed into different facts. */
function canonicalPayload(p: { sessionId: string; testsRun: number; codeDigest: string; evidenceDigest: string; issuedAt: string; v: number }): Buffer {
  const lp = (s: string): string => `${Buffer.byteLength(s, 'utf8')}:${s}`
  const data =
    lp(`v=${p.v}`) +
    lp(`sessionId=${p.sessionId}`) +
    lp(`testsRun=${p.testsRun}`) +
    lp(`codeDigest=${p.codeDigest}`) +
    lp(`evidenceDigest=${p.evidenceDigest}`) +
    lp(`issuedAt=${p.issuedAt}`)
  return Buffer.from(data, 'utf8')
}

/** Generate a fresh Ed25519 keypair as PEM strings (used by the dev-key path + tests). */
export function generatePassportKeypair(): PassportKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return { publicKey, privateKey }
}

/** A value that can sign a passport: either a resolved {@link PassportSigner} (holds a
 *  KeyObject) or a raw {@link PassportKeypair} (PEM strings, e.g. straight from
 *  generatePassportKeypair). Both are normalized to a KeyObject before signing. */
export type Signable = { publicKey: string; privateKeyObject: KeyObject } | PassportKeypair

function toKeyObject(signer: Signable): { publicKey: string; privateKeyObject: KeyObject } {
  if ('privateKeyObject' in signer) return signer
  return { publicKey: signer.publicKey, privateKeyObject: createPrivateKey(signer.privateKey) }
}

/**
 * Sign already-minted, verified facts into a durable {@link BuildPassport}.
 *
 * It SIGNS facts; it does NOT (and cannot) mint verification — the caller obtains the facts
 * from a genuine VerifyToken. The Ed25519 signature is computed over the length-prefixed
 * canonical payload, so a passport cannot be re-interpreted as different facts.
 */
export function signPassport(facts: PassportFacts, signer: Signable, now: Date = new Date()): BuildPassport {
  const { publicKey, privateKeyObject } = toKeyObject(signer)
  const issuedAt = now.toISOString()
  const v = 1 as const
  const payload = canonicalPayload({ ...facts, issuedAt, v })
  const signature = edSign(null, payload, privateKeyObject).toString('base64url')
  return {
    v,
    sessionId: facts.sessionId,
    testsRun: facts.testsRun,
    codeDigest: facts.codeDigest,
    evidenceDigest: facts.evidenceDigest,
    issuedAt,
    signature,
    publicKey,
  }
}

/**
 * Verify a passport's Ed25519 signature against a public key — a PURE function (no I/O, no
 * secret). Returns true iff the signature is a genuine Ed25519 signature over THESE facts by
 * the holder of the matching private key; false on ANY tamper (changed testsRun / digest /
 * signature), a wrong/other key, or a malformed input. NEVER throws.
 *
 * `publicKey` defaults to the SPKI PEM embedded on the passport (read-path convenience). To
 * verify against a TRUSTED, out-of-band public key (the real third-party check), pass it
 * explicitly — then a passport carrying an attacker's own key+signature fails against yours.
 */
export function verifyPassport(passport: BuildPassport, publicKey: string = passport.publicKey): boolean {
  try {
    const payload = canonicalPayload({
      v: passport.v,
      sessionId: passport.sessionId,
      testsRun: passport.testsRun,
      codeDigest: passport.codeDigest,
      evidenceDigest: passport.evidenceDigest,
      issuedAt: passport.issuedAt,
    })
    const key = createPublicKey(publicKey)
    const sig = Buffer.from(passport.signature, 'base64url')
    if (sig.length === 0) return false
    return edVerify(null, payload, key, sig)
  } catch {
    // Malformed key / signature / payload — never a throw at a verification call site.
    return false
  }
}

/**
 * Optional persistence seam for the generated DEV keypair, so a dev/self-host boot reuses a
 * STABLE passport public key across restarts (an operator publishes it once). The default
 * boot uses a file-backed store outside the repo (see {@link fileDevKeyStore}); tests inject
 * a Map. It stores ONLY the dev private/public PEM, NEVER an operator-supplied key.
 */
export interface DevKeyPersist {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

const ENV_PRIVATE_KEY = 'AKIS_PASSPORT_PRIVATE_KEY'
const PERSIST_PRIVATE = 'passport.dev.privateKey'

/**
 * Resolve the passport signer.
 *   1. AKIS_PASSPORT_PRIVATE_KEY set → use that operator key (PKCS#8 PEM); `dev:false`.
 *   2. else → a DEV keypair: reuse the persisted one if present, otherwise generate + persist
 *      one (clearly `dev:true`). Documented as DEV in .env.example / SELF_HOSTING.md.
 *
 * The PRIVATE key is read here and held ONLY as a KeyObject on the returned signer — it is
 * never logged, returned in a response, or placed on a passport (only the PUBLIC key is).
 */
export function loadOrCreatePassportSigner(env: Record<string, string | undefined>, persist?: DevKeyPersist): PassportSigner {
  const configured = env[ENV_PRIVATE_KEY]
  if (configured && configured.trim().length > 0) {
    const privateKeyObject = createPrivateKey(configured)
    const publicKey = createPublicKey(privateKeyObject).export({ type: 'spki', format: 'pem' }).toString()
    return { publicKey, dev: false, privateKeyObject }
  }
  // Dev path: reuse a persisted dev key (stable public key across restarts) or mint one.
  const stored = persist?.get(PERSIST_PRIVATE)
  const privateKeyPem = stored ?? generatePassportKeypair().privateKey
  if (!stored) persist?.set(PERSIST_PRIVATE, privateKeyPem)
  const privateKeyObject = createPrivateKey(privateKeyPem)
  const publicKey = createPublicKey(privateKeyObject).export({ type: 'spki', format: 'pem' }).toString()
  return { publicKey, dev: true, privateKeyObject }
}

/**
 * A {@link DevKeyPersist} backed by a single JSON file (default OUTSIDE the repo, mode 0600),
 * so a dev/self-host boot reuses a STABLE passport key across restarts. It stores ONLY the
 * generated DEV key. Best-effort: a read/write failure degrades to an in-memory key for this
 * boot (the passport still signs+verifies; the public key just changes on the next restart).
 */
export function fileDevKeyStore(path: string): DevKeyPersist {
  return {
    get(_key) {
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
        return raw[PERSIST_PRIVATE]
      } catch { return undefined }
    },
    set(_key, value) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify({ [PERSIST_PRIVATE]: value }, null, 2), { mode: 0o600 })
        try { chmodSync(path, 0o600) } catch { /* best-effort tighten on existing file */ }
      } catch { /* best-effort: fall back to an in-memory key for this boot */ }
    },
  }
}
