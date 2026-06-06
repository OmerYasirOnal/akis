# AKIS Build Provenance Attestation

**What:** A minimal notes REST API on Node built-in http, zero dependencies: POST /api/notes adds a note in-memory, GET /api/notes returns all notes as JSON, GET / serves a small HTML page. server.js listens on process.env.PORT.
**Session:** `0d9d983a-0b79-47d0-ab37-029525aad2c2`
**Issued:** 2026-06-06T16:04:29.380Z
**Built by:** akis-multi-agent (idea → spec → code → verify → push)

## Structural gates
- ✅ Spec approved by a human
- ✅ Independently verified — a real ≥1-test pass
- ✅ Deploy approved by a human

## Verification
- Tests run: **5**
- Code digest: `894edad3602a76ff17fed8ad1ce65d2e7ec425ee8d90c7f3ef9a78db9415823f`
- Evidence digest: `ebb8ff43906a769a0293b27556591dc2257a013ae4ce169f1627538a1f413620`

## Signed passport (verify this)
```json
{
  "v": 1,
  "issuedAt": "2026-06-06T16:04:29.380Z",
  "testsRun": 5,
  "publicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAIZ9NUlFpYjKq4NPjKYvQwka47LOkERRigdjxwf6nMd4=\n-----END PUBLIC KEY-----\n",
  "sessionId": "0d9d983a-0b79-47d0-ab37-029525aad2c2",
  "signature": "dWD26cEoNYvQVK5EwV4LI8e2QhlA0Z2dMbZs14a-BRqgvjRtA5orJs_0OXxn8tfxOqtR5a5E5WzBDwSARDjdBQ",
  "codeDigest": "894edad3602a76ff17fed8ad1ce65d2e7ec425ee8d90c7f3ef9a78db9415823f",
  "evidenceDigest": "ebb8ff43906a769a0293b27556591dc2257a013ae4ce169f1627538a1f413620"
}
```

> CRYPTOGRAPHICALLY SIGNED: the `passport` field only — an Ed25519 signature (passport.signature) over the canonical JSON {sessionId,testsRun,codeDigest,evidenceDigest,issuedAt}, verifiable with passport.publicKey and NO trust in AKIS (see verifyPassport / any Ed25519 verifier). The subject/gates fields are AKIS-asserted context from the build's durable session state. This is verifiable build PROVENANCE (SLSA/in-toto-aligned), not a compliance certificate.
