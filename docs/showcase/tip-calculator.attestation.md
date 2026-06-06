# AKIS Build Provenance Attestation

**What:** A tiny static tip calculator: bill amount and tip percent inputs, shows the per-person total live; vanilla JS, no dependencies, single self-contained index.html.
**Session:** `fb9cfca4-de07-4131-ac5d-111a81a81277`
**Issued:** 2026-06-06T15:56:53.297Z
**Built by:** akis-multi-agent (idea → spec → code → verify → push)

## Structural gates
- ✅ Spec approved by a human
- ✅ Independently verified — a real ≥1-test pass
- ✅ Deploy approved by a human

## Verification
- Tests run: **4**
- Code digest: `58800221af9deb796868a58a8498aaf8b191b0a1a6d963c082b5df2958d93bf1`
- Evidence digest: `ee33d4d4c07bb0b63945c7005fc7c8588a2c8c6fe3c3a672db87b613807b464e`

## Signed passport (verify this)
```json
{
  "v": 1,
  "issuedAt": "2026-06-06T15:56:53.297Z",
  "testsRun": 4,
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIZ9NUlFpYjKq4NPjKYvQwka47LOkERRigdjxwf6nMd4=\n-----END PUBLIC KEY-----\n",
  "sessionId": "fb9cfca4-de07-4131-ac5d-111a81a81277",
  "signature": "5MwjQZzhLdpC2pUMgLx_2DgRrtI1SDx0in13GWDclRw3HrtC2JO2FO5mcagI5fc7pkq9Hsl0kNMXf_hBktjuDA",
  "codeDigest": "58800221af9deb796868a58a8498aaf8b191b0a1a6d963c082b5df2958d93bf1",
  "evidenceDigest": "ee33d4d4c07bb0b63945c7005fc7c8588a2c8c6fe3c3a672db87b613807b464e"
}
```

> CRYPTOGRAPHICALLY SIGNED: the `passport` field only — an Ed25519 signature (passport.signature) over the canonical JSON {sessionId,testsRun,codeDigest,evidenceDigest,issuedAt}, verifiable with passport.publicKey and NO trust in AKIS (see verifyPassport / any Ed25519 verifier). The subject/gates fields are AKIS-asserted context from the build's durable session state. This is verifiable build PROVENANCE (SLSA/in-toto-aligned), not a compliance certificate.
