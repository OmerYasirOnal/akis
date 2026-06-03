import { createServer } from 'node:net'

const reserved = new Set<number>()

/** Resolve true iff `port` is currently OS-bindable on loopback. */
function isBindable(port: number): Promise<boolean> {
  return new Promise(res => {
    const srv = createServer()
    srv.unref()
    srv.on('error', () => res(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)))
  })
}

/**
 * Allocate a free loopback port by binding to :0, reading the OS-assigned port,
 * then releasing it — and reserve it in-process so two concurrent previews don't
 * race onto the same port between allocation and the child actually binding.
 *
 * After skipping any port already handed out (the in-memory `reserved` set), the
 * incremented candidate is RE-VERIFIED as actually OS-bindable — `:0` only proves the
 * original was free, but `reserved.has(port) → port++` walks onto arbitrary numbers that
 * another (non-AKIS) process may already hold. On a clash we restart from a fresh `:0`.
 */
export function allocatePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', rejectP)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { srv.close(); rejectP(new Error('no port')); return }
      let port = addr.port
      srv.close(() => {
        void (async () => {
          // Skip any port already handed out but not yet bound by its child.
          while (reserved.has(port)) port++
          // If we walked off the OS-assigned port, the increment may have landed on a port
          // some other process holds — re-verify it's actually bindable, else re-roll.
          if (port !== addr.port && !(await isBindable(port))) { resolveP(await allocatePort()); return }
          reserved.add(port)
          resolveP(port)
        })()
      })
    })
  })
}

/** Release a reserved port once its preview has stopped (or failed to start). */
export function releasePort(port: number): void {
  reserved.delete(port)
}
