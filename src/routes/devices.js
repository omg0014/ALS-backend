import crypto from 'node:crypto'
import { Router } from 'express'
import { Channel, Command, ConfigChange, Device, DeviceState, HardwareProfile, LightingGroup, Room } from '../models/index.js'
import { EDITOR } from '../lib/auth.js'
import { normaliseDeviceId } from '../lib/deviceId.js'
import { badRequest, conflict, notFound } from '../lib/errors.js'
import { isAllowedGpio, loadWarnings } from '../lib/hardwareRules.js'
import { logChange } from '../services/changeLog.js'
import { emit } from '../services/realtime.js'
import { kickDevice } from '../services/broker.js'
import { encrypt } from '../services/mqttConfig.js'
import { refreshSimpleBoard, testSimpleBoard } from '../services/simpleBoards.js'

const router = Router()
const changed = () => emit('devices:changed', {})

async function loadDevice(id) {
  const device = await Device.findById(id).populate('profile')
  if (!device) throw notFound('Device not found')
  return device
}

async function profileWarnings(profile) {
  return profile.verified || profile.simple ? [] : [`Profile ${profile.code} is UNVERIFIED (${profile.statusNote || 'not bench tested'}). Use for bench testing only.`]
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

// ---- Simple MQTT boards (their own code; the website publishes ON/OFF to their topic) ----

const LINE_TYPES = ['lights', 'fans', 'mixed', 'ac', 'load']
const topicError = (t, label) =>
  !t ? `${label} is required` : /[#+]/.test(t) ? `${label} cannot contain # or +` : t.length > 200 ? `${label} is too long` : /\s$|^\s/.test(t) ? `${label} has spaces at the start or end` : null

// Validates the form; a blank password keeps the saved one (existing = the board being edited)
async function simpleInput(body, existing) {
  const b = body ?? {}
  const errors = []
  const name = String(b.name ?? '').trim()
  if (!name) errors.push('Name: e.g. "10-A AC"')
  if (!b.room || !(await Room.exists({ _id: b.room }))) errors.push('Choose the classroom')
  const host = String(b.host ?? '').trim().replace(/^(mqtts?|wss?):\/\//, '').replace(/[:/].*$/, '')
  if (!/^[a-z0-9.-]+$/i.test(host)) errors.push('Broker: e.g. broker.hivemq.com')
  const tls = Boolean(b.tls)
  const port = Number(b.port) || (tls ? 8883 : 1883)
  if (port === 8884 || port === 8000) errors.push('Port: use 1883 (or 8883 encrypted). 8884/8000 are for web browsers only')
  const commandTopic = String(b.commandTopic ?? '')
  const stateTopic = String(b.stateTopic ?? '')
  const e1 = topicError(commandTopic, 'Topic')
  if (e1) errors.push(e1)
  if (stateTopic && topicError(stateTopic, 'State topic')) errors.push(topicError(stateTopic, 'State topic'))
  const onPayload = String(b.onPayload ?? '')
  const offPayload = String(b.offPayload ?? '')
  if (!onPayload.trim() || !offPayload.trim()) errors.push('Messages: what to send for ON and for OFF')
  else if (onPayload.trim().toUpperCase() === offPayload.trim().toUpperCase()) errors.push('Messages: ON and OFF must be different')
  const line = b.line ?? {}
  if (!line.group && !LINE_TYPES.includes(line.type)) errors.push('What it switches: choose a type')
  if (errors.length) throw badRequest('Please check the board details', errors)
  let password = b.password ? String(b.password) : ''
  if (!password && existing?.simple?.passwordEnc && String(b.username ?? '') === (existing.simple.username ?? '')) password = null // keep
  return {
    name,
    room: b.room,
    line: { group: line.group || null, type: line.type, name: String(line.name ?? '').trim() },
    simple: {
      url: `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`,
      username: String(b.username ?? '').trim(),
      ...(password === null ? {} : { passwordEnc: password ? encrypt(password) : '' }),
      commandTopic,
      stateTopic,
      onPayload,
      offPayload,
      retain: b.retain !== false,
    },
  }
}

// The line (lighting group) this board switches: one of the room's, or a new one
async function lineForRoom(line, roomId) {
  if (line.group) return validGroupForRoom(line.group, roomId)
  const count = await LightingGroup.countDocuments({ room: roomId, type: line.type })
  const fallback = { lights: 'Lights', fans: 'Fans', mixed: 'Lights and fans', ac: 'AC', load: 'TV / smart board' }[line.type]
  const group = await LightingGroup.create({ room: roomId, name: line.name || `${fallback} ${count + 1}`, type: line.type, estimatedAmps: 0 })
  return group._id
}

router.post('/simple/test', EDITOR, async (req, res) => {
  const b = req.body ?? {}
  const existing = b.device ? await Device.findById(b.device).select('+simple.passwordEnc').lean() : null
  const host = String(b.host ?? '').trim().replace(/^(mqtts?|wss?):\/\//, '').replace(/[:/].*$/, '')
  if (!/^[a-z0-9.-]+$/i.test(host)) throw badRequest('Broker: e.g. broker.hivemq.com')
  const tls = Boolean(b.tls)
  const port = Number(b.port) || (tls ? 8883 : 1883)
  let password = b.password ? String(b.password) : ''
  if (!password && existing?.simple?.passwordEnc) {
    const { decrypt } = await import('../services/mqttConfig.js')
    password = decrypt(existing.simple.passwordEnc)
  }
  res.json(await testSimpleBoard({ url: `${tls ? 'mqtts' : 'mqtt'}://${host}:${port}`, username: String(b.username ?? '').trim(), password, stateTopic: String(b.stateTopic ?? '') }))
})

router.post('/simple', EDITOR, async (req, res) => {
  const b = await simpleInput(req.body, null)
  const profile = await HardwareProfile.findOne({ code: 'MQTT', simple: true }).lean()
  if (!profile) throw badRequest('Restart the server once: the "own code" hardware type is missing')
  let deviceId
  do deviceId = `mqtt-${crypto.randomBytes(3).toString('hex')}`
  while (await Device.exists({ deviceId }))
  const lightingGroup = await lineForRoom(b.line, b.room)
  const device = await Device.create({
    deviceId,
    kind: 'simple',
    name: b.name,
    room: b.room,
    profile: profile._id,
    mqttUsername: deviceId,
    status: 'active',
    simple: { ...b.simple, synced: false },
  })
  await Channel.create({ device: device._id, index: 1, gpio: 0, lightingGroup })
  await DeviceState.create({ device: device._id, deviceId, channelStates: [0] })
  await logChange(req, 'device', 'create', null, { ...device.toObject(), simple: { ...b.simple, passwordEnc: undefined } })
  await refreshSimpleBoard(deviceId)
  changed()
  res.status(201).json({ device: { _id: device._id, deviceId, name: device.name } })
})

router.put('/:id/simple', EDITOR, async (req, res) => {
  const device = await Device.findById(req.params.id).select('+simple.passwordEnc')
  if (!device || device.kind !== 'simple') throw notFound('Simple MQTT board not found')
  if (device.status === 'retired') throw conflict('Device is retired')
  const before = device.toObject()
  const b = await simpleInput(req.body, before)
  const s = before.simple ?? {}
  const moved = s.url !== b.simple.url || s.commandTopic !== b.simple.commandTopic || s.stateTopic !== b.simple.stateTopic
  device.name = b.name
  device.room = b.room
  device.simple = { ...s, ...b.simple, synced: moved ? false : s.synced }
  await device.save()
  const lightingGroup = await lineForRoom(b.line, b.room)
  await Channel.updateOne({ device: device._id, index: 1 }, { $set: { lightingGroup } })
  await logChange(req, 'device', 'update', { ...before, simple: { ...s, passwordEnc: undefined } }, { ...device.toObject(), simple: { ...device.simple, passwordEnc: undefined } })
  await refreshSimpleBoard(device.deviceId)
  changed()
  res.json({ device: { _id: device._id, deviceId: device.deviceId, name: device.name } })
})

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
  if (device.kind === 'simple') await refreshSimpleBoard(device.deviceId)
  await logChange(req, 'device', 'update', before, device)
  changed()
  res.json({ ok: true })
})

// Replace a failed board: the new board inherits this record's room, channels, groups and history.
router.post('/:id/replace', EDITOR, async (req, res) => {
  const device = await loadDevice(req.params.id)
  if (device.status === 'retired') throw conflict('Device is retired')
  if (device.kind === 'simple') throw badRequest('A board on its own code is changed with "Edit board" instead')
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
