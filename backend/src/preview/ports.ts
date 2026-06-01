import { createServer } from 'node:net'

const reserved = new Set<number>()

/**
 * Allocate a free loopback port by binding to :0, reading the OS-assigned port,
 * then releasing it — and reserve it in-process so two concurrent previews don't
 * race onto the same port between allocation and the child actually binding.
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
        // Skip any port already handed out but not yet bound by its child.
        while (reserved.has(port)) port++
        reserved.add(port)
        resolveP(port)
      })
    })
  })
}

/** Release a reserved port once its preview has stopped (or failed to start). */
export function releasePort(port: number): void {
  reserved.delete(port)
}
