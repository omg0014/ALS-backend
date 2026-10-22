import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { User } from '../models/index.js'
import { hashPassword, verifyPassword } from '../lib/crypto.js'
import { clearSession, issueSession, issueSocketToken, publicUser, requireAuth } from '../lib/auth.js'
import { HttpError, badRequest } from '../lib/errors.js'

const router = Router()

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again in 15 minutes' },
})

router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body ?? {}
  if (!username || !password) throw badRequest('Username and password are required')
  const user = await User.findOne({ username: String(username).toLowerCase().trim(), active: true }).select('+passwordHash')
  if (!user || !(await verifyPassword(String(password), user.passwordHash))) throw new HttpError(401, 'Wrong username or password')
  user.lastLoginAt = new Date()
  await user.save()
  issueSession(res, user)
  res.json({ user: publicUser(user) })
})

router.post('/logout', (req, res) => {
  clearSession(res)
  res.json({ ok: true })
})

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }))
router.get('/socket-token', requireAuth, (req, res) => res.json({ token: issueSocketToken(req.user) }))

router.put('/me/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body ?? {}
  if (!newPassword || String(newPassword).length < 8) throw badRequest('New password must be at least 8 characters')
  const user = await User.findById(req.user._id).select('+passwordHash')
  if (!(await verifyPassword(String(currentPassword ?? ''), user.passwordHash))) throw badRequest('Current password is wrong')
  user.passwordHash = await hashPassword(String(newPassword))
  await user.save()
  res.json({ ok: true })
})

export default router
