import { Router } from 'express'
import { HardwareProfile } from '../models/index.js'
import { ADMIN } from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import { allowedPins, isAllowedGpio } from '../lib/hardwareRules.js'
import { logChange } from '../services/changeLog.js'

const router = Router()

router.get('/', async (req, res) => {
  const profiles = await HardwareProfile.find().sort({ code: 1, version: -1 }).lean()
  res.json(profiles.map((p) => ({ ...p, allowedPins: allowedPins(p.espModel) })))
})

// New hardware profile (C1 wizard). Always saved UNVERIFIED until the bench checklist passes.
router.post('/', ADMIN, async (req, res) => {
  const b = req.body ?? {}
  const channels = Number(b.channels)
  const pins = Array.isArray(b.pins) ? b.pins.map((p) => ({ label: String(p.label ?? ''), gpio: Number(p.gpio) })) : []
  if (!['esp32', 'esp8266'].includes(b.espModel)) throw badRequest('ESP model must be esp32 or esp8266')
  if (!channels || channels < 1 || channels > 16) throw badRequest('Channels must be 1-16')
  if (pins.length !== channels) throw badRequest(`Give exactly ${channels} relay pin(s)`)
  const bad = pins.filter((p) => !isAllowedGpio(b.espModel, p.gpio))
  if (bad.length) throw badRequest(`Not allowed relay pins for ${b.espModel}: ${bad.map((p) => `GPIO${p.gpio}`).join(', ')}`)
  if (new Set(pins.map((p) => p.gpio)).size !== pins.length) throw badRequest('Each channel needs its own pin')
  const allowed = allowedPins(b.espModel)
  const profile = await HardwareProfile.create({
    code: String(b.code ?? '').trim().toUpperCase(),
    version: 1,
    espModel: b.espModel,
    espBoard: b.espBoard,
    relayModule: b.relayModule,
    moduleKind: ['blue4', 'blue2', 'red30'].includes(b.moduleKind) ? b.moduleKind : 'other',
    channels,
    trigger: b.trigger,
    triggerNote: b.triggerNote ?? '',
    pins: pins.map((p) => ({ label: allowed.find((a) => a.gpio === p.gpio)?.label ?? `GPIO${p.gpio}`, gpio: p.gpio })),
    contactRatingA: Number(b.contactRatingA) || undefined,
    maxAmpsPerChannel: b.maxAmpsPerChannel ? Number(b.maxAmpsPerChannel) : null,
    statusLed: b.espModel === 'esp8266' ? { gpio: 2, activeLow: true } : { gpio: null },
    setupNotes: (Array.isArray(b.setupNotes) ? b.setupNotes : String(b.setupNotes ?? '').split('\n')).map((n) => n.trim()).filter(Boolean),
    verified: false,
    statusNote: 'Unverified: new profile, bench test pending',
  })
  await logChange(req, 'hardwareProfile', 'create', null, profile)
  res.status(201).json(profile)
})

// Pins and trigger levels of a profile are never edited here (versioning is Phase 4).
// Only an admin may mark a profile verified after the bench checklist passes; this is logged.
router.patch('/:id/verification', ADMIN, async (req, res) => {
  const profile = await HardwareProfile.findById(req.params.id)
  if (!profile) throw notFound('Profile not found')
  const before = profile.toObject()
  profile.verified = Boolean(req.body?.verified)
  if (typeof req.body?.statusNote === 'string') profile.statusNote = req.body.statusNote
  await profile.save()
  await logChange(req, 'hardwareProfile', 'update', before, profile)
  res.json(profile)
})

export default router
