import { Router } from 'express'
import { EDITOR } from '../lib/auth.js'
import { badRequest, forbidden } from '../lib/errors.js'
import { previewTarget, switchTarget } from '../services/commands.js'
import { actorOf } from '../services/changeLog.js'

const router = Router()

function readTarget(req) {
  const { target, state } = req.body ?? {}
  if (!target?.kind) throw badRequest('target is required')
  if (target.kind !== 'all' && !target.id) throw badRequest('target.id is required')
  // Floor-wide and school-wide switching is a bulk action: admin only.
  if (['floor', 'all'].includes(target.kind) && req.user.role !== 'admin') throw forbidden('Only an admin can switch a whole floor or the school')
  return { target: { kind: target.kind, id: target.id }, state }
}

// Counts for the confirmation dialog ("N groups will change").
router.post('/preview', EDITOR, async (req, res) => {
  const { target, state } = readTarget(req)
  res.json(await previewTarget(target, state))
})

router.post('/', EDITOR, async (req, res) => {
  const { target, state } = readTarget(req)
  res.json(await switchTarget({ target, state, user: req.user, actor: actorOf(req), sourceIp: req.ip }))
})

export default router
