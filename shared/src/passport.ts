/**
 * BuildPassport — AKIS's signed, portable "trust" artifact (wire type).
 *
 * It turns AKIS's in-process verification (the branded, fail-closed VerifyToken) into a
 * DURABLE, third-party-verifiable proof: a passport asymmetrically signs (Ed25519) the
 * ALREADY-MINTED facts a VerifyToken carries — {sessionId, testsRun, codeDigest,
 * evidenceDigest, issuedAt}. Anyone holding the public key can verify it OFFLINE.
 *
 * ADDITIVE, NON-GATE: the passport ATTESTS facts that were already earned through the
 * gates; it can never mint or forge verification. Gate truth stays the presence of a
 * `verifyToken` (see `isVerified`); the passport is a portable proof OF that truth. The
 * signing/verification helpers live in the backend (`backend/src/verify/passport.ts`,
 * node:crypto) — this is only the serialized shape carried on the session + the wire.
 */
export interface BuildPassport {
  /** Wire-format version, so a future field addition stays verifiable. */
  v: 1
  /** The build session this attests. */
  sessionId: string
  /** Number of tests the genuine ≥1-test pass ran (the VerifyToken's testsRun). */
  testsRun: number
  /** Digest binding verified-code to pushed-code (the VerifyToken's codeDigest). */
  codeDigest: string
  /** Tamper-evidence digest of the STRUCTURED test evidence (the VerifyToken's evidenceDigest). */
  evidenceDigest: string
  /** ISO-8601 issuance time (when the passport was signed). */
  issuedAt: string
  /** Base64url Ed25519 signature over the canonical payload. */
  signature: string
  /** The SPKI public key (PEM) that signed it — PUBLIC by definition; the private key is
   *  NEVER placed on a passport. Lets a reader verify without out-of-band key exchange. */
  publicKey: string
}
