import { Router } from 'express'
import { Draft } from '../models/index.js'

// Wizard progress, saved after each step so it can be resumed (never the WiFi password).
const router = Router()

router.get('/drafts/:key', async (req, res) => {
  res.json(await Draft.findOne({ user: req.user._id, key: req.params.key }).lean())
})

router.get('/drafts', async (req, res) => {
  res.json(await Draft.find({ user: req.user._id }).sort({ updatedAt: -1 }).lean())
})

router.put('/drafts/:key', async (req, res) => {
  const { step = 0, data = {} } = req.body ?? {}
  // Never keep the WiFi password in a draft.
  const { wifiPassword: _omit, ...safe } = data
  const draft = await Draft.findOneAndUpdate(
    { user: req.user._id, key: req.params.key },
    { $set: { step: Number(step), data: safe } },
    { upsert: true, returnDocument: 'after' }
  ).lean()
  res.json(draft)
})

router.delete('/drafts/:key', async (req, res) => {
  await Draft.deleteOne({ user: req.user._id, key: req.params.key })
  res.json({ ok: true })
})

export default router
