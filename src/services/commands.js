import { Channel, Command, DeviceState, Floor, LightingGroup, Room } from '../models/index.js'
import { newId } from '../lib/crypto.js'
import { notFound, forbidden, badRequest } from '../lib/errors.js'
import { canUseFloor } from '../lib/auth.js'
import { publishCommand } from './broker.js'
import { isSimpleId, publishSimple } from './simpleBoards.js'
import { emit } from './realtime.js'
import { getSetting } from './settings.js'

// channel key -> newest batch that touched it. An older batch still sending skips that channel.
const latestBatch = new Map()
const chKey = (deviceId, index) => `${deviceId}:${index}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const commandView = (c) => ({
  cmdId: c.cmdId,
  batchId: c.batchId,
  deviceId: c.deviceId,
  channel: c.channel,
  lightingGroup: c.lightingGroup,
  desired: c.desired,
  result: c.result,
  latencyMs: c.latencyMs,
})

// Resolve group / room / floor / all to the channels that feed it, with live state.
export async function resolveTarget({ kind, id }) {
  let groups
  let label
  if (kind === 'group') {
    const g = await LightingGroup.findById(id).populate('room').lean()
    if (!g) throw notFound('Lighting group not found')
    groups = [g]
    label = `${g.room?.displayName ?? '?'} / ${g.name}`
  } else if (kind === 'room') {
    const room = await Room.findById(id).lean()
    if (!room) throw notFound('Room not found')
    groups = await LightingGroup.find({ room: room._id }).lean()
    label = room.displayName
  } else if (kind === 'floor') {
    const floor = await Floor.findById(id).lean()
    if (!floor) throw notFound('Floor not found')
    const rooms = await Room.find({ floor: floor._id }, '_id').lean()
    groups = await LightingGroup.find({ room: { $in: rooms.map((r) => r._id) } }).lean()
    label = floor.name
  } else if (kind === 'all') {
    groups = await LightingGroup.find().lean()
    label = 'Whole school'
  } else {
    throw badRequest('target.kind must be group, room, floor or all')
  }

  const roomIds = [...new Set(groups.map((g) => String(g.room?._id ?? g.room)))]
  const rooms = await Room.find({ _id: { $in: roomIds } }, 'floor').lean()
  const floorOfRoom = new Map(rooms.map((r) => [String(r._id), String(r.floor)]))

  const channels = (
    await Channel.find({ lightingGroup: { $in: groups.map((g) => g._id) } })
      .populate('device')
      .lean()
  ).filter((c) => c.device?.status === 'active')
  const states = await DeviceState.find({ device: { $in: channels.map((c) => c.device._id) } }).lean()
  const stateOf = new Map(states.map((s) => [String(s.device), s]))
  const groupById = new Map(groups.map((g) => [String(g._id), g]))

  const entries = channels.map((c) => {
    const st = stateOf.get(String(c.device._id))
    const group = groupById.get(String(c.lightingGroup))
    return {
      channel: c,
      device: c.device,
      online: Boolean(st?.online),
      confirmed: st?.channelStates?.[c.index - 1] ?? null,
      floorId: floorOfRoom.get(String(group.room?._id ?? group.room)),
    }
  })

  return { label, groups, entries, floorIds: [...new Set(roomIds.map((r) => floorOfRoom.get(r)))] }
}

export async function previewTarget(target, state) {
  const desired = state === 'ON' ? 1 : 0
  const { label, groups, entries } = await resolveTarget(target)
  const changing = new Set(entries.filter((e) => e.confirmed !== desired || !e.online).map((e) => String(e.channel.lightingGroup)))
  const wired = new Set(entries.map((e) => String(e.channel.lightingGroup)))
  return {
    label,
    groupsTotal: groups.length,
    groupsChanging: changing.size,
    groupsNotWired: groups.filter((g) => !wired.has(String(g._id))).length,
    channels: entries.length,
    channelsOffline: entries.filter((e) => !e.online).length,
  }
}

// Switch a target. Desired state is saved for every channel (so offline devices pick it up on reconnect);
// online channels get a command now, staggered to limit inrush.
export async function switchTarget({ target, state, user, actor, sourceIp }) {
  if (!['ON', 'OFF'].includes(state)) throw badRequest('state must be ON or OFF')
  const resolved = await resolveTarget(target)
  if (user && resolved.floorIds.some((f) => !canUseFloor(user, f))) throw forbidden('You are not allowed to control this floor')
  if (!resolved.entries.length) throw badRequest(`Nothing to switch: no relay channel is mapped to ${resolved.label}`)

  await Channel.updateMany(
    { _id: { $in: resolved.entries.map((e) => e.channel._id) } },
    { $set: { desiredState: state === 'ON' ? 1 : 0 } }
  )
  return dispatch(
    resolved.entries.map((e) => ({ ...e, desired: state })),
    { actor, sourceIp, target: { kind: target.kind, id: target.id ? String(target.id) : undefined, label: resolved.label } }
  )
}

async function dispatch(entries, { actor, sourceIp, target }) {
  const batchId = newId(8)
  const docs = entries.map((e) => ({
    cmdId: newId(6),
    batchId,
    actor,
    sourceIp,
    target,
    device: e.device._id,
    deviceId: e.device.deviceId,
    channel: e.channel.index,
    lightingGroup: e.channel.lightingGroup,
    desired: e.desired,
    result: e.online ? 'pending' : 'queued_offline',
  }))
  await Command.insertMany(docs)
  for (const d of docs) latestBatch.set(chKey(d.deviceId, d.channel), batchId)
  docs.forEach((d) => emit('command', commandView(d)))

  const toSend = docs.filter((d) => d.result === 'pending')
  sendStaggered(toSend).catch((err) => console.error('[commands] send loop failed', err))

  return {
    batchId,
    label: target.label,
    sent: toSend.length,
    queuedOffline: docs.length - toSend.length,
    commands: docs.map(commandView),
  }
}

async function sendStaggered(docs) {
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i]
    if (i > 0) {
      const gap = d.desired === 'ON' ? getSetting('staggerMs') : getSetting('staggerOffMs')
      if (gap) await sleep(gap)
    }
    if (latestBatch.get(chKey(d.deviceId, d.channel)) !== d.batchId) {
      await setResult(d.cmdId, ['pending'], { result: 'superseded' })
      continue
    }
    await sendOne(d)
  }
}

async function sendOne(d) {
  const sentAt = new Date()
  await Command.updateOne({ cmdId: d.cmdId }, { $set: { sentAt } })
  try {
    if (isSimpleId(d.deviceId)) {
      // A board on its own code: its state topic confirms it; without one, "sent" is all we know
      const nothingWillConfirm = await publishSimple(d.deviceId, d.desired)
      if (nothingWillConfirm) return setResult(d.cmdId, ['pending'], { result: 'confirmed', confirmedAt: new Date(), latencyMs: 0 })
    } else {
      await publishCommand(d.deviceId, { id: d.cmdId, ch: d.channel, state: d.desired })
    }
  } catch (err) {
    console.error('[commands] publish failed', err.message)
    return setResult(d.cmdId, ['pending'], { result: 'failed' })
  }
  setTimeout(
    () => setResult(d.cmdId, ['pending'], { result: 'not_confirmed' }).catch(() => {}),
    getSetting('confirmTimeoutMs')
  )
}

async function setResult(cmdId, fromResults, update) {
  const cmd = await Command.findOneAndUpdate(
    { cmdId, result: { $in: fromResults } },
    { $set: update },
    { returnDocument: 'after' }
  ).lean()
  if (cmd) emit('command', commandView(cmd))
  return cmd
}

// Device replied with {"ch":[...],"ack":cmdId}. Confirmed only when the reported channel matches.
export async function handleAck(deviceId, cmdId, channelStates) {
  const cmd = await Command.findOne({ cmdId, deviceId }).lean()
  if (!cmd || !['pending', 'not_confirmed'].includes(cmd.result)) return
  const ok = channelStates[cmd.channel - 1] === (cmd.desired === 'ON' ? 1 : 0)
  const now = new Date()
  await setResult(cmdId, ['pending', 'not_confirmed'], {
    result: ok ? 'confirmed' : 'failed',
    confirmedAt: now,
    latencyMs: cmd.sentAt ? now - cmd.sentAt : undefined,
  })
}

// First state report after a device (re)connects. Restore mode re-sends the saved desired state;
// "off" mode never switches anything ON: it syncs the database to OFF instead.
export async function reconcileDevice(device, reported) {
  const channels = await Channel.find({ device: device._id }).lean()
  const mode = getSetting('powerLossBehaviour')
  const toSend = []
  for (const c of channels) {
    const actual = reported[c.index - 1] ?? 0
    if (actual === c.desiredState) continue
    if (mode === 'off' && c.desiredState === 1) {
      await Channel.updateOne({ _id: c._id }, { $set: { desiredState: 0 } })
      continue
    }
    toSend.push({ channel: c, device, online: true, desired: c.desiredState ? 'ON' : 'OFF' })
  }
  if (!toSend.length) return null
  // OFF first, then ON with the normal stagger
  toSend.sort((a, b) => (a.desired === b.desired ? a.channel.index - b.channel.index : a.desired === 'OFF' ? -1 : 1))
  console.log(`[commands] restoring ${toSend.length} channel(s) on ${device.deviceId} (${mode})`)
  return dispatch(toSend, {
    actor: { kind: 'system', name: 'restore after reconnect' },
    target: { kind: 'restore', id: device.deviceId, label: `Restore ${device.name}` },
  })
}

// After a server restart nothing is in flight any more.
export async function closeStaleCommands() {
  await Command.updateMany({ result: 'pending' }, { $set: { result: 'not_confirmed' } })
}
