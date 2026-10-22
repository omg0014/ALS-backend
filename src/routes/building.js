import { Router } from 'express'
import { Channel, Device, Floor, LightingGroup, Room } from '../models/index.js'
import { ADMIN, EDITOR } from '../lib/auth.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { loadWarnings } from '../lib/hardwareRules.js'
import { logChange } from '../services/changeLog.js'
import { emit } from '../services/realtime.js'

const router = Router()
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]))
const changed = () => emit('devices:changed', {})

// ---- Floors ----

const FLOOR_FIELDS = ['name', 'order']

router.get('/floors', async (req, res) => {
  res.json(await Floor.find().sort({ order: 1, name: 1 }).lean())
})

router.post('/floors', ADMIN, async (req, res) => {
  const floor = await Floor.create(pick(req.body, FLOOR_FIELDS))
  await logChange(req, 'floor', 'create', null, floor)
  changed()
  res.status(201).json(floor)
})

router.put('/floors/:id', ADMIN, async (req, res) => {
  const floor = await Floor.findById(req.params.id)
  if (!floor) throw notFound('Floor not found')
  const before = floor.toObject()
  floor.set(pick(req.body, FLOOR_FIELDS))
  await floor.save()
  await logChange(req, 'floor', 'update', before, floor)
  changed()
  res.json(floor)
})

router.delete('/floors/:id', ADMIN, async (req, res) => {
  const floor = await Floor.findById(req.params.id)
  if (!floor) throw notFound('Floor not found')
  if (await Room.exists({ floor: floor._id })) throw conflict('Move or delete the rooms on this floor first')
  await floor.deleteOne()
  await logChange(req, 'floor', 'delete', floor, null)
  changed()
  res.json({ ok: true })
})

// ---- Rooms ----

const ROOM_FIELDS = ['floor', 'type', 'standard', 'section', 'roomNumber', 'displayName', 'stage']

function defaultDisplayName(body) {
  if (body.displayName) return body.displayName
  const cls = [body.standard, body.section].filter(Boolean).join('-')
  return [cls, body.roomNumber && `Room ${body.roomNumber}`].filter(Boolean).join(' · ') || undefined
}

router.get('/rooms', async (req, res) => {
  const filter = req.query.floor ? { floor: req.query.floor } : {}
  res.json(await Room.find(filter).sort({ displayName: 1 }).lean())
})

router.post('/rooms', ADMIN, async (req, res) => {
  const data = pick(req.body, ROOM_FIELDS)
  data.displayName = defaultDisplayName(data)
  if (!(await Floor.exists({ _id: data.floor }))) throw badRequest('Choose a valid floor')
  const room = await Room.create(data)
  await logChange(req, 'room', 'create', null, room)
  changed()
  res.status(201).json(room)
})

router.put('/rooms/:id', ADMIN, async (req, res) => {
  const room = await Room.findById(req.params.id)
  if (!room) throw notFound('Room not found')
  const before = room.toObject()
  const data = pick(req.body, ROOM_FIELDS)
  if (data.floor && !(await Floor.exists({ _id: data.floor }))) throw badRequest('Choose a valid floor')
  if (data.displayName === '') data.displayName = defaultDisplayName({ ...before, ...data })
  room.set(data)
  await room.save()
  await logChange(req, 'room', 'update', before, room)
  changed()
  res.json(room)
})

router.delete('/rooms/:id', ADMIN, async (req, res) => {
  const room = await Room.findById(req.params.id)
  if (!room) throw notFound('Room not found')
  if (await Device.exists({ room: room._id, status: { $ne: 'retired' } })) throw conflict('Move or retire the devices in this room first')
  if (await LightingGroup.exists({ room: room._id })) throw conflict('Delete the lighting groups in this room first')
  await room.deleteOne()
  await logChange(req, 'room', 'delete', room, null)
  changed()
  res.json({ ok: true })
})

// ---- Lighting groups ----

const GROUP_FIELDS = ['room', 'name', 'type', 'switches', 'estimatedAmps']

// Load warnings for every channel that feeds this group.
async function groupWarnings(group) {
  const channels = await Channel.find({ lightingGroup: group._id }).populate({ path: 'device', populate: 'profile' }).lean()
  return channels.flatMap((c) => loadWarnings(c.device?.profile, group))
}

router.get('/groups', async (req, res) => {
  const filter = req.query.room ? { room: req.query.room } : {}
  res.json(await LightingGroup.find(filter).sort({ name: 1 }).lean())
})

router.post('/groups', EDITOR, async (req, res) => {
  const data = pick(req.body, GROUP_FIELDS)
  if (!(await Room.exists({ _id: data.room }))) throw badRequest('Choose a valid room')
  const group = await LightingGroup.create(data)
  await logChange(req, 'lightingGroup', 'create', null, group)
  changed()
  res.status(201).json({ ...group.toObject(), warnings: [] })
})

router.put('/groups/:id', EDITOR, async (req, res) => {
  const group = await LightingGroup.findById(req.params.id)
  if (!group) throw notFound('Lighting group not found')
  const before = group.toObject()
  const data = pick(req.body, GROUP_FIELDS)
  if (data.room && String(data.room) !== String(group.room)) {
    if (await Channel.exists({ lightingGroup: group._id })) throw conflict('Unassign this group from its relay channels before moving it to another room')
  }
  group.set(data)
  await group.save()
  await logChange(req, 'lightingGroup', 'update', before, group)
  changed()
  res.json({ ...group.toObject(), warnings: await groupWarnings(group) })
})

router.delete('/groups/:id', EDITOR, async (req, res) => {
  const group = await LightingGroup.findById(req.params.id)
  if (!group) throw notFound('Lighting group not found')
  // Its channels become spare (and OFF in the database).
  await Channel.updateMany({ lightingGroup: group._id }, { $set: { lightingGroup: null, desiredState: 0 } })
  await group.deleteOne()
  await logChange(req, 'lightingGroup', 'delete', group, null)
  changed()
  res.json({ ok: true })
})

export default router
