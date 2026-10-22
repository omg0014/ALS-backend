import { Router } from 'express'
import { config } from '../config.js'
import { Device } from '../models/index.js'
import { ADMIN } from '../lib/auth.js'
import { badRequest } from '../lib/errors.js'
import { logChange } from '../services/changeLog.js'
import { SETTING_DEFS, allSettings, setSetting, validateSetting } from '../services/settings.js'

// Global settings (broker address, stagger, timeouts, alert levels...). Read by all, changed by admins.
const router = Router()

router.get('/settings', (req, res) => {
  // mqtt: where the boards connect: this server's built-in broker, or an external one (cloud)
  res.json({ values: allSettings(), defs: SETTING_DEFS, mqtt: config.externalMqtt ? { external: true, tls: config.externalMqtt.tls } : { external: false } })
})

router.put('/settings', ADMIN, async (req, res) => {
  const updates = req.body ?? {}
  const errors = Object.entries(updates).map(([k, v]) => validateSetting(k, v)).filter(Boolean)
  if (errors.length) throw badRequest('Invalid settings', errors)
  const before = allSettings()
  const notes = []
  let reflash = false
  for (const [k, v] of Object.entries(updates)) {
    if (before[k] === v) continue
    await setSetting(k, v)
    if (SETTING_DEFS[k].reflash) reflash = true
    if (k === 'topicRoot') notes.push('Topic root takes effect after a server restart.')
  }
  if (reflash) {
    // Every board must get a config.h with the new broker / topic settings.
    const at = new Date()
    await Device.updateMany({ status: { $ne: 'retired' } }, { $push: { updateReasons: { reason: 'Broker settings changed', at } } })
    notes.push('All devices are flagged "update needed": regenerate and flash their config.h.')
  }
  await logChange(req, 'settings', 'update', { _id: 'settings', ...before }, { _id: 'settings', ...allSettings() })
  res.json({ values: allSettings(), notes })
})

export default router
