import { Router } from 'express'
import { Command, ConfigChange } from '../models/index.js'

// Activity log: every ON/OFF command and every configuration change (kept 1 year).
const router = Router()

router.get('/audit/commands', async (req, res) => {
  const q = {}
  if (req.query.deviceId) q.deviceId = req.query.deviceId
  if (req.query.result) q.result = req.query.result
  if (req.query.actor) q['actor.name'] = new RegExp(String(req.query.actor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) }
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  res.json(await Command.find(q).sort({ createdAt: -1 }).limit(limit).lean())
})

router.get('/audit/changes', async (req, res) => {
  const q = {}
  if (req.query.entity) q.entity = req.query.entity
  if (req.query.before) q.time = { $lt: new Date(req.query.before) }
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  res.json(await ConfigChange.find(q).sort({ time: -1 }).limit(limit).lean())
})

export default router
