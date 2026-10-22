import { Server } from 'socket.io'
import { COOKIE_NAME, userFromToken } from '../lib/auth.js'
import { config } from '../config.js'

let io = null

function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: config.corsOrigins, credentials: true } })
  io.use(async (socket, next) => {
    // Same address: the session cookie. Website on another address: a short-lived token from /api/auth/socket-token
    const token = socket.handshake.auth?.token
    const user = token ? await userFromToken(token, 'socket') : await userFromToken(readCookie(socket.handshake.headers.cookie, COOKIE_NAME))
    if (!user) return next(new Error('unauthorized'))
    socket.data.user = user
    next()
  })
  io.on('connection', (socket) => socket.join('authed'))
  return io
}

// Events: device:state, command, devices:changed
export function emit(event, payload) {
  io?.to('authed').emit(event, payload)
}
