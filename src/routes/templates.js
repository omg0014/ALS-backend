import { Router } from 'express'
import { DeviceTemplate, HardwareProfile } from '../models/index.js'
import { EDITOR } from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import { logChange } from '../services/changeLog.js'

// Device templates for the "Add a device" wizard. Everyone can use them; staff and admins save new ones.
const router = Router()
const TYPES = ['lights', 'fans', 'mixed', 'ac', 'load', 'all']

router.get('/', async (req, res) => {
  res.json(await DeviceTemplate.find().sort({ builtIn: -1, name: 1 }).lean())
})

router.post('/', EDITOR, async (req, res) => {
  const b = req.body ?? {}
  const name = String(b.name ?? '').trim()
  if (!name) throw badRequest('Give the template a name, e.g. "ESP-12E + 30 A · 1 AC"')
  const profile = await HardwareProfile.findById(b.profile).lean()
  if (!profile) throw badRequest('Choose the relay board')
  const counts = Object.fromEntries(TYPES.map((t) => [t, Math.max(0, Math.floor(Number(b.counts?.[t]) || 0))]))
  const total = Object.values(counts).reduce((a, c) => a + c, 0)
  if (!total) throw badRequest('A template needs at least one line')
  if (total > profile.channels) throw badRequest(`This relay board has only ${profile.channels} relay(s) for ${total} lines`)
  if (await DeviceTemplate.exists({ name })) throw badRequest(`A template called "${name}" already exists`)
  const t = await DeviceTemplate.create({ name, espModel: profile.espModel, profile: profile._id, counts })
  await logChange(req, 'deviceTemplate', 'create', null, t)
  res.status(201).json(t)
})

router.delete('/:id', EDITOR, async (req, res) => {
  const t = await DeviceTemplate.findById(req.params.id)
  if (!t) throw notFound('Template not found')
  if (t.builtIn) throw badRequest('Built-in templates cannot be removed')
  await t.deleteOne()
  await logChange(req, 'deviceTemplate', 'delete', t, null)
  res.json({ ok: true })
})

export default router
