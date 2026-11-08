import type { Server } from 'node:http'
import { serve } from '@hono/node-server'
import { LOOPBACK_HOST, WS_PATH } from '@corsen-ai/shared'
import type { DaemonContext } from '../daemon/context'
import { createApp } from './app'
import { allowedHosts } from './guards'

export interface RunningServer {
  readonly port: number
  close(): Promise<void>
}

/**
 * Bind HTTP + WebSocket on 127.0.0.1 only. WebSocket upgrades are checked (path, Host) here and
 * handed to the hub, which enforces the extension Origin and the HMAC handshake.
 */
export function startServer(ctx: DaemonContext, onShutdown: () => void): Promise<RunningServer> {
  const app = createApp(ctx, { onShutdown })
  const hosts = allowedHosts(ctx.port, ctx.extraAllowedHosts)
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port: ctx.port, hostname: LOOPBACK_HOST }) as Server
    server.on('upgrade', (request, socket, head) => {
      const path = (request.url ?? '/').split('?')[0]
      const host = (request.headers.host ?? '').toLowerCase()
      if (path !== WS_PATH || !hosts.has(host)) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        socket.destroy()
        return
      }
      ctx.hub.handleUpgrade(request, socket, head)
    })
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'EADDRINUSE' ? new Error(`port ${ctx.port} is already in use on ${LOOPBACK_HOST}`) : error)
    })
    server.once('listening', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : ctx.port
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            ctx.hub.close()
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}
