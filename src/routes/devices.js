import { Router } from 'express'
import { Channel, Command, ConfigChange, Device, DeviceState, HardwareProfile, LightingGroup, Room } from '../models/index.js'
import { EDITOR } from '../lib/auth.js'
import { normaliseDeviceId } from '../lib/deviceId.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { isAllowedGpio, loadWarnings } from '../lib/hardwareRules.js'
import { logChange } from '../services/changeLog.js'
import { emit } from '../services/realtime.js'
import { kickDevice } from '../services/broker.js'

const router = Router()
const changed = () => emit('devices:changed', {})

async function loadDevice(id) {
  const device = await Device.findById(id).populate('profile')
  if (!device) throw notFound('Device not found')
  return device
}

async function profileWarnings(profile) {
  return profile.verified ? [] : [`Profile ${profile.code} is UNVERIFIED (${profile.statusNote || 'not bench tested'}). Use for bench testing only.`]
}

async function channelWarnings(device) {
  const channels = await Channel.find({ device: device._id }).populate('lightingGroup').lean()
  return channels.flatMap((c) => loadWarnings(device.profile, c.lightingGroup).map((w) => `IN${c.index}: ${w}`))
}

async function validGroupForRoom(groupId, roomId) {
  if (groupId == null || groupId === '') return null
  const group = await LightingGroup.findById(groupId).lean()
  if (!group) throw badRequest('Lighting group not found')
  if (!roomId || String(group.room) !== String(roomId)) throw badRequest(`Group "${group.name}" belongs to a different room than this device`)
  return group._id
}

function addUpdateReason(device, reason) {
  device.updateReasons.push({ reason, at: new Date() })
}

router.get('/:id', async (req, res) => {
  const device = await Device.findById(req.params.id).populate('profile').populate({ path: 'room', populate: 'floor' }).lean()
  if (!device) throw notFound('Device not found')
  const [channels, state, commands, history] = await Promise.all([
    Channel.find({ device: device._id }).sort({ index: 1 }).populate('lightingGroup').lean(),
    DeviceState.findOne({ device: device._id }).lean(),
    Command.find({ device: device._id }).sort({ createdAt: -1 }).limit(25).lean(),
    ConfigChange.find({ entity: 'device', entityId: String(device._id) }).sort({ time: -1 }).limit(25).lean(),
  ])
  res.json({
    device: { ...device, updateNeeded: device.updateReasons?.length > 0 },
    channels,
    state,
    commands,
    history,
    warnings: [...(await profileWarnings(device.profile)), ...channels.flatMap((c) => loadWarnings(device.profile, c.lightingGroup).map((w) => `IN${c.index}: ${w}`))],
  })
})

router.post('/', EDITOR, async (req, res) => {
  const body = req.body ?? {}
  const deviceId = normaliseDeviceId(body.chipId ?? body.deviceId)
  // A board that was removed earlier can be added again: its old record comes back (history kept)
  const removed = await Device.findOne({ deviceId })
  if (removed && removed.status !== 'retired') throw conflict(`This board (${deviceId}) is already set up as "${removed.name}". Open it on the Devices page instead.`)
  const profile = await HardwareProfile.findById(body.profile)
  if (!profile) throw badRequest('Choose a hardware profile')
  if (body.room && !(await Room.exists({ _id: body.room }))) throw badRequest('Room not found')

  // Channel count always matches the profile; pins come from the profile.
  const mapping = Array.isArray(body.channels) ? body.channels : []
  const groupIds = []
  for (let i = 1; i <= profile.channels; i++) {
    groupIds.push(await validGroupForRoom(mapping.find((m) => Number(m.index) === i)?.lightingGroup, body.room))
  }

  const fields = {
    name: body.name || deviceId,
    room: body.room || null,
    profile: profile._id,
    mac: body.mac ?? removed?.mac ?? '',
    status: body.room ? 'active' : 'spare',
    updateReasons: [{ reason: 'Not flashed with ACLS firmware yet', at: new Date() }],
  }
  let device
  if (removed) {
    const before = removed.toObject()
    removed.set({ ...fields, pendingBuild: null })
    device = await removed.save()
    await Channel.deleteMany({ device: device._id })
    await DeviceState.deleteOne({ device: device._id })
    await logChange(req, 'device', 'update', before, device)
  } else {
    device = await Device.create({ deviceId, mqttUsername: deviceId, ...fields })
    await logChange(req, 'device', 'create', null, device)
  }
  await Channel.insertMany(
    groupIds.map((lightingGroup, i) => ({ device: device._id, index: i + 1, gpio: profile.pins[i].gpio, lightingGroup }))
  )
  await DeviceState.create({ device: device._id, deviceId, channelStates: Array(profile.channels).fill(0) })
  changed()
  await device.populate('profile')
  res.status(removed ? 200 : 201).json({ device, restored: Boolean(removed), warnings: [...(await profileWarnings(profile)), ...(await channelWarnings(device))] })
})

router.put('/:id', EDITOR, async (req, res) => {
  const device = await loadDevice(req.params.id)
  if (device.status === 'retired') throw conflict('Device is retired')
  const before = device.toObject()
  const body = req.body ?? {}
  const notes = []

  for (const k of ['name', 'mac', 'installedOn']) if (body[k] !== undefined) device[k] = body[k]
  if (body.status !== undefined) {
    if (!['active', 'spare'].includes(body.status)) throw badRequest('Use the retire action to retire a device')
    device.status = body.status
  }
  if (body.room !== undefined && String(body.room ?? '') !== String(device.room ?? '')) {
    if (body.room && !(await Room.exists({ _id: body.room }))) throw badRequest('Room not found')
    device.room = body.room || null
    // Groups belong to rooms: channels of a moved device become spare. No re-flash needed.
    const r = await Channel.updateMany({ device: device._id, lightingGroup: { $ne: null } }, { $set: { lightingGroup: null, desiredState: 0 } })
    if (r.modifiedCount) notes.push(`${r.modifiedCount} channel(s) were unassigned because their groups belong to the old room.`)
  }
  if (body.profile !== undefined && String(body.profile) !== String(device.profile._id)) {
    if (req.user.role !== 'admin') throw badRequest('Only an admin can change the hardware profile')
    const profile = await HardwareProfile.findById(body.profile)
    if (!profile) throw badRequest('Profile not found')
    await Channel.deleteMany({ device: device._id })
    await Channel.insertMany(profile.pins.slice(0, profile.channels).map((p, i) => ({ device: device._id, index: i + 1, gpio: p.gpio })))
    await DeviceState.updateOne({ device: device._id }, { $set: { channelStates: Array(profile.channels).fill(0) } })
    device.profile = profile._id
    addUpdateReason(device, `Profile changed to ${profile.code}`)
    notes.push('Profile changed: channels reset from the new profile. Re-flash needed.')
  }
  await device.save()
  await device.populate('profile')
  await logChange(req, 'device', 'update', before, device)
  changed()
  res.json({ device, notes, warnings: [...(await profileWarnings(device.profile)), ...(await channelWarnings(device))] })
})

// Reassign a channel to a group (or spare); admins may change the pin, only to an allowed one.
router.put('/:id/channels/:index', EDITOR, async (req, res) => {
  const device = await loadDevice(req.params.id)
  const channel = await Channel.findOne({ device: device._id, index: Number(req.params.index) })
  if (!channel) throw notFound('Channel not found')
  const before = channel.toObject()
  const body = req.body ?? {}

  if (body.lightingGroup !== undefined) channel.lightingGroup = await validGroupForRoom(body.lightingGroup, device.room)
  if (body.gpio !== undefined && Number(body.gpio) !== channel.gpio) {
    if (req.user.role !== 'admin') throw badRequest('Only an admin can change a relay pin')
    const gpio = Number(body.gpio)
    if (!isAllowedGpio(device.profile.espModel, gpio)) throw badRequest(`GPIO${gpio} is not an allowed relay pin for ${device.profile.espModel}`)
    if (await Channel.exists({ device: device._id, gpio, _id: { $ne: channel._id } })) throw badRequest(`GPIO${gpio} is already used by another channel`)
    channel.gpio = gpio
    addUpdateReason(device, `IN${channel.index} pin changed to GPIO${gpio}`)
    await device.save()
  }
  await channel.save()
  await logChange(req, 'channel', 'update', before, channel)
  changed()
  const group = channel.lightingGroup ? await LightingGroup.findById(channel.lightingGroup).lean() : null
  res.json({ channel, warnings: loadWarnings(device.profile, group) })
})

router.post('/:id/retire', EDITOR, async (req, res) => {
  const device = await loadDevice(req.params.id)
  const before = device.toObject()
  device.status = 'retired'
  device.credentialHash = undefined
  device.pendingCredentialHash = undefined
  device.pendingBuild = null
  await device.save()
  await Channel.updateMany({ device: device._id }, { $set: { lightingGroup: null, desiredState: 0 } })
  kickDevice(device.deviceId)
  await logChange(req, 'device', 'update', before, device)
  changed()
  res.json({ ok: true })
})

// Replace a failed board: the new board inherits this record's room, channels, groups and history.
router.post('/:id/replace', EDITOR, async (req, res) => {
  const device = await loadDevice(req.params.id)
  if (device.status === 'retired') throw conflict('Device is retired')
  const newId = normaliseDeviceId(req.body?.chipId)
  if (newId === device.deviceId) throw badRequest('That is the current board')
  if (await Device.exists({ deviceId: newId })) throw conflict(`${newId} is already registered`)
  const before = device.toObject()
  const oldId = device.deviceId
  kickDevice(oldId)
  device.previousIds.push(oldId)
  device.deviceId = newId
  device.mqttUsername = newId
  device.credentialHash = undefined
  device.credentialsIssuedAt = null
  device.pendingCredentialHash = undefined
  device.pendingIssuedAt = null
  device.pendingBuild = null
  device.firmwareVersion = ''
  device.updateReasons.push({ reason: `Board replaced (${oldId} → ${newId}): generate and upload firmware`, at: new Date() })
  await device.save()
  await DeviceState.updateOne(
    { device: device._id },
    { $set: { deviceId: newId, online: false, rssi: null, uptime: null, fw: null, rebootReason: null, recentBoots: [], needsReconcile: false } }
  )
  await logChange(req, 'device', 'update', before, device)
  changed()
  res.json({ device })
})

export default router
