import { Router } from 'express'
import { User } from '../models/index.js'
import { ADMIN, publicUser } from '../lib/auth.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { hashPassword } from '../lib/crypto.js'
import { logChange } from '../services/changeLog.js'

// Website logins (admin only).
const router = Router()

const ROLES = ['admin', 'staff', 'viewer']

router.get('/users', ADMIN, async (req, res) => {
  const users = await User.find().sort({ name: 1 }).lean()
  res.json(users.map((u) => ({ ...publicUser(u), active: u.active, lastLoginAt: u.lastLoginAt })))
})

router.post('/users', ADMIN, async (req, res) => {
  const { name, username, password, role = 'viewer', allowedFloors = [] } = req.body ?? {}
  if (!name || !username) throw badRequest('Name and username are required')
  if (!password || String(password).length < 8) throw badRequest('Password must be at least 8 characters')
  if (!ROLES.includes(role)) throw badRequest('Unknown role')
  const user = await User.create({ name, username, role, allowedFloors, passwordHash: await hashPassword(String(password)) })
  await logChange(req, 'user', 'create', null, user)
  res.status(201).json(publicUser(user))
})

router.put('/users/:id', ADMIN, async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) throw notFound('User not found')
  const before = user.toObject()
  const { name, role, allowedFloors, active, password } = req.body ?? {}
  if (role !== undefined && !ROLES.includes(role)) throw badRequest('Unknown role')
  const losingAdmin = user.role === 'admin' && ((role && role !== 'admin') || active === false)
  if (losingAdmin && (await User.countDocuments({ role: 'admin', active: true })) <= 1) throw conflict('Keep at least one active admin')
  if (name !== undefined) user.name = name
  if (role !== undefined) user.role = role
  if (allowedFloors !== undefined) user.allowedFloors = allowedFloors
  if (active !== undefined) user.active = Boolean(active)
  if (password) {
    if (String(password).length < 8) throw badRequest('Password must be at least 8 characters')
    user.passwordHash = await hashPassword(String(password))
  }
  await user.save()
  await logChange(req, 'user', 'update', before, user)
  res.json({ ...publicUser(user), active: user.active })
})

export default router
