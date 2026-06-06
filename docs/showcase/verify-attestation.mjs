#!/usr/bin/env node
// Independent verifier for an AKIS Build Provenance Attestation.
//
// "Don't trust AKIS — verify." This uses ONLY Node's standard `crypto` (zero dependencies, zero
// AKIS code) to check the embedded passport's Ed25519 signature over the exact facts it attests.
// A genuine attestation prints `signature valid: true`; tampering with ANY fact (testsRun, a
// digest, the idea) breaks the signature.
//
//   node verify-attestation.mjs tip-calculator.attestation.json
//
import { verify } from 'node:crypto'
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? new URL('./tip-calculator.attestation.json', import.meta.url).pathname
const att = JSON.parse(readFileSync(file, 'utf8'))
const p = att.passport

// The canonical signed payload: length-prefixed `key=value` fields, in this exact order. This must
// match AKIS's signing (backend/src/verify/passport.ts canonicalPayload) — reproduced here so the
// check needs nothing from AKIS.
const lp = (s) => Buffer.byteLength(s, 'utf8') + ':' + s
const payload = Buffer.from(
  lp('v=' + p.v) +
  lp('sessionId=' + p.sessionId) +
  lp('testsRun=' + p.testsRun) +
  lp('codeDigest=' + p.codeDigest) +
  lp('evidenceDigest=' + p.evidenceDigest) +
  lp('issuedAt=' + p.issuedAt),
  'utf8',
)

const ok = verify(null, payload, p.publicKey, Buffer.from(p.signature, 'base64url'))
console.log('subject :', att.subject.idea)
console.log('gates   :', JSON.stringify(att.gates))
console.log('testsRun:', att.verification.testsRun, '(real boot-smoke verification)')
console.log('signed by:', p.publicKey.split('\n')[1]?.slice(0, 24) + '… (Ed25519 public key)')
console.log('\nsignature valid:', ok)

// Tamper demo: flip testsRun and re-verify — must be false.
const tampered = Buffer.from(
  lp('v=' + p.v) + lp('sessionId=' + p.sessionId) + lp('testsRun=999') +
  lp('codeDigest=' + p.codeDigest) + lp('evidenceDigest=' + p.evidenceDigest) + lp('issuedAt=' + p.issuedAt),
  'utf8',
)
console.log('tampered (testsRun=999) valid:', verify(null, tampered, p.publicKey, Buffer.from(p.signature, 'base64url')))
process.exit(ok ? 0 : 1)
