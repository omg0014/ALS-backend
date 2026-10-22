import { Router } from 'express'
import { Guide } from '../models/index.js'
import { ADMIN } from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import { actorOf, logChange } from '../services/changeLog.js'

const router = Router()

router.get('/', async (req, res) => {
  res.json(await Guide.find({}, 'slug title category order updatedAt').sort({ category: 1, order: 1, title: 1 }).lean())
})

router.get('/:slug', async (req, res) => {
  const guide = await Guide.findOne({ slug: req.params.slug }).lean()
  if (!guide) throw notFound('Guide not found')
  res.json(guide)
})

// Guides are Markdown that admins can correct without a developer.
router.post('/', ADMIN, async (req, res) => {
  const { slug, title, category, order, markdown } = req.body ?? {}
  if (!slug || !title) throw badRequest('Slug and title are required')
  const guide = await Guide.create({ slug, title, category, order, markdown, updatedBy: actorOf(req) })
  await logChange(req, 'guide', 'create', null, guide)
  res.status(201).json(guide)
})

router.put('/:slug', ADMIN, async (req, res) => {
  const guide = await Guide.findOne({ slug: req.params.slug })
  if (!guide) throw notFound('Guide not found')
  const before = guide.toObject()
  for (const k of ['title', 'category', 'order', 'markdown']) if (req.body?.[k] !== undefined) guide[k] = req.body[k]
  guide.updatedBy = actorOf(req)
  await guide.save()
  await logChange(req, 'guide', 'update', before, guide)
  res.json(guide)
})

router.delete('/:slug', ADMIN, async (req, res) => {
  const guide = await Guide.findOneAndDelete({ slug: req.params.slug })
  if (!guide) throw notFound('Guide not found')
  await logChange(req, 'guide', 'delete', guide, null)
  res.json({ ok: true })
})

export default router
