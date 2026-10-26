import { Router } from 'express'
import { badRequest } from '../lib/errors.js'
import { analyticsReport } from '../services/analytics.js'

// How long lights, fans and the rest were ON: whole school, per floor, per classroom, per line, per day.
const router = Router()
const TYPES = ['lights', 'fans', 'mixed', 'ac', 'load', 'all']
const MAX_DAYS = 400

router.get('/analytics', async (req, res) => {
  const q = req.query
  const to = q.to ? new Date(q.to) : new Date()
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 24 * 3600e3)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw badRequest('Choose a start date before the end date')
  if (to - from > MAX_DAYS * 24 * 3600e3) throw badRequest(`Choose at most ${MAX_DAYS} days`)
  if (q.type && !TYPES.includes(q.type)) throw badRequest('Unknown type')
  const tzOffset = Math.max(-840, Math.min(840, Number(q.tz) || 0))
  res.json(await analyticsReport({ from, to, tzOffset, floor: q.floor || undefined, type: q.type || undefined, room: q.room || undefined }))
})

export default router
