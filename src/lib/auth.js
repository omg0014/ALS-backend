import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { User } from '../models/index.js'
import { HttpError, forbidden } from './errors.js'

export const COOKIE_NAME = 'acls_session'

export function issueSession(res, user) {
  const token = jwt.sign({ sub: String(user._id) }, config.jwtSecret, { expiresIn: `${config.sessionHours}h` })
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    maxAge: config.sessionHours * 3600 * 1000,
  })
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME)
}

// Short-lived token for the live-updates connection when the website runs on another address than
// this server (Vercel → Render): the session cookie belongs to the website's address, not to this one.
export const issueSocketToken = (user) => jwt.sign({ sub: String(user._id), use: 'socket' }, config.jwtSecret, { expiresIn: '2m' })

// Looks the user up on every request so deactivation and role changes apply at once.
// use: undefined for the session cookie, 'socket' for a live-updates token (never interchangeable).
export async function userFromToken(token, use) {
  if (!token) return null
  try {
    const payload = jwt.verify(token, config.jwtSecret)
    if (payload.use !== use) return null
    const user = await User.findById(payload.sub).lean()
    return user?.active ? user : null
  } catch {
    return null
  }
}

export async function requireAuth(req, _res, next) {
  const user = await userFromToken(req.cookies?.[COOKIE_NAME])
  if (!user) throw new HttpError(401, 'Please log in')
  req.user = user
  next()
}

export const requireRole =
  (...roles) =>
  (req, _res, next) => {
    if (!roles.includes(req.user?.role)) throw forbidden()
    next()
  }

export const ADMIN = requireRole('admin')
export const EDITOR = requireRole('admin', 'staff')

export function publicUser(u) {
  return { _id: u._id, name: u.name, username: u.username, role: u.role, allowedFloors: u.allowedFloors ?? [] }
}

// Staff with allowedFloors set may only act on those floors (PRD F5.2).
export function canUseFloor(user, floorId) {
  if (user.role === 'admin') return true
  if (!user.allowedFloors?.length) return true
  return user.allowedFloors.some((f) => String(f) === String(floorId))
}
