import { Router } from 'express'
import { BenchTest, Channel, CommissioningRecord, Device, DeviceState, FirmwareBuild, LightingGroup, Room } from '../models/index.js'
import { EDITOR } from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import { benchChecklist } from '../lib/firmware/index.js'
import { actorOf, logChange } from '../services/changeLog.js'
import { emit } from '../services/realtime.js'

const router = Router()
const STAGE_ORDER = ['draft', 'bench_tested', 'installed', 'live']

async function setStage(req, room, stage) {
  if (room.stage === stage) return
  const before = room.toObject()
  room.stage = stage
  await room.save()
  await logChange(req, 'room', 'update', before, room)
  emit('devices:changed', {})
}

async function installState(roomId) {
  const room = await Room.findById(roomId).populate('floor').lean()
  if (!room) throw notFound('Room not found')
  const groups = await LightingGroup.find({ room: room._id }).sort({ name: 1 }).lean()
  const devices = await Device.find({ room: room._id, status: { $ne: 'retired' } }).populate('profile').lean()
  const ids = devices.map((d) => d._id)
  const [channels, states, benches, builds, records] = await Promise.all([
    Channel.find({ device: { $in: ids } }).sort({ index: 1 }).lean(),
    DeviceState.find({ device: { $in: ids } }).lean(),
    BenchTest.find({ device: { $in: ids } }).sort({ at: -1 }).lean(),
    FirmwareBuild.find({ device: { $in: ids } }).sort({ createdAt: -1 }).lean(),
    CommissioningRecord.find({ room: room._id }).sort({ at: -1 }).lean(),
  ])
  const first = (list, key, id) => list.find((x) => String(x[key]) === String(id)) ?? null

  const devs = devices.map((d) => ({
    ...d,
    updateNeeded: d.updateReasons?.length > 0,
    channels: channels.filter((c) => String(c.device) === String(d._id)),
    state: first(states, 'device', d._id),
    bench: first(benches, 'device', d._id),
    build: first(builds, 'device', d._id),
    checklist: benchChecklist(d.profile),
  }))
  const feeds = channels.filter((c) => c.lightingGroup)
  const wiredGroups = groups.filter((g) => feeds.some((c) => String(c.lightingGroup) === String(g._id)))
  const commissioning = groups.map((g) => ({ group: g, record: first(records, 'lightingGroup', g._id), wired: wiredGroups.includes(g) }))

  const steps = [
    { key: 'room', title: 'Create the room and its lighting groups', done: groups.length > 0 },
    { key: 'device', title: 'Add the device and pick the hardware profile', done: devs.length > 0 && devs.every((d) => d.channels.some((c) => c.lightingGroup)) },
    { key: 'wiring', title: 'View the wiring diagram and table', done: devs.length > 0 },
    { key: 'bench', title: 'Bench test on the desk', done: devs.length > 0 && devs.every((d) => d.bench?.passed) },
    {
      key: 'flash',
      title: 'Upload the production firmware and confirm it shows online',
      done: devs.length > 0 && devs.every((d) => d.build && d.state?.lastSeen && !d.updateNeeded),
    },
    { key: 'install', title: 'Installation by the electrician (printable wiring sheet)', done: STAGE_ORDER.indexOf(room.stage) >= 2 },
    {
      key: 'commission',
      title: 'Commissioning test from the website',
      done: wiredGroups.length > 0 && commissioning.filter((c) => c.wired).every((c) => c.record?.result === 'pass'),
    },
    { key: 'live', title: 'Mark the room Live', done: room.stage === 'live' },
  ]
  return { room, groups, devices: devs, commissioning, steps }
}

router.get('/rooms/:id/install', async (req, res) => {
  res.json(await installState(req.params.id))
})

// Bench checklist (each channel clicks, COM-NO closes on ON, no reboot when all switch, ...).
router.post('/devices/:id/bench-test', EDITOR, async (req, res) => {
  const device = await Device.findById(req.params.id)
  if (!device) throw notFound('Device not found')
  const checks = (req.body?.checks ?? []).map((c) => ({ key: c.key, label: String(c.label ?? c.key), ok: Boolean(c.ok) }))
  if (!checks.length) throw badRequest('Tick the checklist first')
  const passed = checks.every((c) => c.ok)
  const record = await BenchTest.create({
    device: device._id,
    room: device.room,
    profile: device.profile,
    checks,
    passed,
    notes: req.body?.notes ?? '',
    by: actorOf(req),
  })
  if (passed && device.room) {
    const room = await Room.findById(device.room)
    if (room?.stage === 'draft') await setStage(req, room, 'bench_tested')
  }
  res.status(201).json(record)
})

// One commissioning result per lighting group: switched from the website, the right lights responded?
router.post('/rooms/:id/commissioning', EDITOR, async (req, res) => {
  const room = await Room.findById(req.params.id)
  if (!room) throw notFound('Room not found')
  const group = await LightingGroup.findOne({ _id: req.body?.lightingGroup, room: room._id }).lean()
  if (!group) throw badRequest('Lighting group not found in this room')
  if (!['pass', 'fail'].includes(req.body?.result)) throw badRequest('result must be pass or fail')
  const channel = await Channel.findOne({ lightingGroup: group._id }).lean()
  const record = await CommissioningRecord.create({
    room: room._id,
    device: channel?.device,
    channel: channel?.index,
    lightingGroup: group._id,
    groupName: group.name,
    result: req.body.result,
    notes: req.body?.notes ?? '',
    installer: actorOf(req),
  })
  res.status(201).json(record)
})

router.put('/rooms/:id/stage', EDITOR, async (req, res) => {
  const stage = req.body?.stage
  if (!STAGE_ORDER.includes(stage)) throw badRequest('Unknown stage')
  const room = await Room.findById(req.params.id)
  if (!room) throw notFound('Room not found')
  if (stage === 'live') {
    const { commissioning } = await installState(room._id)
    const missing = commissioning.filter((c) => c.wired && c.record?.result !== 'pass').map((c) => c.group.name)
    if (missing.length) throw badRequest('Commissioning not passed for every wired group', missing)
  }
  await setStage(req, room, stage)
  res.json(await installState(room._id))
})

export default router
