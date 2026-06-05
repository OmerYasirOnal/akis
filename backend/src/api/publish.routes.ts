import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PublishProfileStore } from '../keys/PublishProfileStore.js'
import {
  validHost, validSshUser, validTargetDir, validAppPort, validPublicUrl, looksLikePem,
} from '../publish/validate.js'

export interface PublishRoutesDeps {
  profiles: PublishProfileStore
  /** Resolve the signed-in user id (undefined when unauthenticated) — the SAME revocation-aware
   *  closure the rest of the server uses, so only the authenticated owner reaches their profile. */
  userIdOf: (req: FastifyRequest) => Promise<string | undefined>
}

/**
 * Per-user "publish destination" (OCI free-tier) — the SSH key + host/user/dir/port/url the
 * owner sets from Settings so a `done` build can deploy to THEIR OWN server. Mirrors
 * githubConnect.routes discipline EXACTLY: 401 when unauthenticated; a fail-closed `canStore()`
 * preflight that refuses BEFORE persisting (encryption not configured → 409 EncryptionNotConfigured);
 * every untrusted Settings field shape-validated via the publish validators BEFORE use; the SSH
 * private key NEVER appears in any URL, log line, or response body (status carries only non-secret
 * metadata + a key fingerprint). No `users` dep — it never mints a session cookie or mutates a user.
 *
 * The publish ACTION itself lives in sessions.routes (`POST /sessions/:id/publish`, owner-scoped via
 * accessibleSession) — this route only manages the stored destination.
 */
export function registerPublishRoutes(app: FastifyInstance, deps: PublishRoutesDeps): void {
  // The caller's publish destination — drives the Settings card. NEVER returns the key.
  app.get('/publish/profile', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    const s = deps.profiles.status(userId)
    // `configured` reflects encryption usability (canStore) — so the FE never shows a Save that
    // would fail at storage time. `present` reflects a stored, DECRYPTABLE profile (usability,
    // not mere presence — a rotated master reads as no-profile, fail-closed).
    return { configured: deps.profiles.canStore(), present: !!s, ...(s ?? {}) }
  })

  // Set (create/replace) the caller's publish destination. Fail-closed preflight + strict
  // shape-validation of EVERY field BEFORE any persist (these values later flow into AKIS's OWN
  // spawned ssh/scp argv — see validate.ts for the option-injection threat model).
  app.put<{ Body: {
    host?: unknown; sshUser?: unknown; sshPrivateKey?: unknown; targetDir?: unknown; appPort?: unknown; publicUrl?: unknown
  } }>('/publish/profile', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    // FAIL-CLOSED PREFLIGHT: refuse BEFORE persisting if encryption can't store the key (mirrors
    // #119's connect preflight — encryptSecret would otherwise throw at storage time).
    if (!deps.profiles.canStore()) {
      return reply.code(409).send({ error: 'encryption not configured (set AI_KEY_ENCRYPTION_KEY)', code: 'EncryptionNotConfigured' })
    }
    const b = req.body ?? {}
    // Validate EACH field; reject with 400 + a field-specific code on the FIRST failure. The host
    // check is first because a leading-`-` host is the OpenSSH option-injection (RCE) vector.
    if (!validHost(b.host)) return reply.code(400).send({ error: 'invalid host', code: 'BadHost' })
    if (!validSshUser(b.sshUser)) return reply.code(400).send({ error: 'invalid ssh user', code: 'BadSshUser' })
    if (!validTargetDir(b.targetDir)) return reply.code(400).send({ error: 'invalid target dir', code: 'BadTargetDir' })
    if (b.appPort !== undefined && !validAppPort(b.appPort)) return reply.code(400).send({ error: 'invalid app port (1025..65535)', code: 'BadAppPort' })
    if (b.publicUrl !== undefined && b.publicUrl !== '' && !validPublicUrl(b.publicUrl)) return reply.code(400).send({ error: 'invalid public url', code: 'BadPublicUrl' })
    if (!looksLikePem(b.sshPrivateKey)) return reply.code(400).send({ error: 'ssh key must be a PEM private key', code: 'BadKey' })

    // All validated — persist (the key is encrypted at rest under akis:publish:<uid>). The PEM is
    // never echoed back; we respond with the status projection only.
    deps.profiles.set(userId, {
      host: b.host,
      sshUser: b.sshUser,
      sshPrivateKey: b.sshPrivateKey,
      targetDir: b.targetDir,
      ...(b.appPort !== undefined ? { appPort: b.appPort as number } : {}),
      ...(b.publicUrl !== undefined && b.publicUrl !== '' ? { publicUrl: b.publicUrl as string } : {}),
    })
    const s = deps.profiles.status(userId)
    return reply.send({ configured: deps.profiles.canStore(), present: !!s, ...(s ?? {}) })
  })

  // Remove the caller's stored destination.
  app.delete('/publish/profile', async (req, reply) => {
    const userId = await deps.userIdOf(req)
    if (!userId) return reply.code(401).send({ error: 'unauthorized', code: 'Unauthorized' })
    deps.profiles.remove(userId)
    return { removed: true }
  })
}
