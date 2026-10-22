import { Device, DeviceState } from '../models/index.js'
import { emit } from './realtime.js'
import { handleAck, reconcileDevice } from './commands.js'
import { onOtaReport } from './firmware/jobs.js'
import { markNewestFirmwareInstalled } from './firmware/installed.js'

export const stateView = (s) =>
  s && {
    device: s.device,
    deviceId: s.deviceId,
    online: s.online,
    lastSeen: s.lastSeen,
    onlineSince: s.onlineSince,
    rssi: s.rssi,
    uptime: s.uptime,
    heap: s.heap,
    fw: s.fw,
    rebootReason: s.rebootReason,
    channelStates: s.channelStates,
    recentBoots: s.recentBoots,
  }

const upsertState = (device, update) =>
  DeviceState.findOneAndUpdate(
    { device: device._id },
    { ...update, $setOnInsert: { deviceId: device.deviceId } },
    { upsert: true, returnDocument: 'after' }
  ).lean()

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// Each device's messages are handled strictly in arrival order ("online" must land before the
// first "state" so the restore runs), while different devices proceed in parallel.
const queues = new Map()
function enqueue(deviceId, task) {
  const next = (queues.get(deviceId) ?? Promise.resolve())
    .then(task)
    .catch((err) => console.error(`[device ${deviceId}]`, err))
  queues.set(deviceId, next)
  next.then(() => queues.get(deviceId) === next && queues.delete(deviceId))
  return next
}

// Messages a device publishes on acls/v1/{deviceId}/{status|state|telemetry}.
export const onDeviceMessage = (deviceId, leaf, payload) => enqueue(deviceId, () => handleMessage(deviceId, leaf, payload))
export const onDeviceDisconnect = (deviceId) => enqueue(deviceId, () => markOffline(deviceId))

async function handleMessage(deviceId, leaf, payload) {
  const device = await Device.findOne({ deviceId }).lean()
  if (!device) return
  const now = new Date()
  let state

  if (leaf === 'ota') return onOtaReport(deviceId, payload)
  if (leaf === 'status') {
    if (payload === 'online') {
      // The next state report triggers the restore / sync for this connection.
      state = await upsertState(device, { $set: { online: true, lastSeen: now, onlineSince: now, needsReconcile: true } })
    } else if (payload === 'offline') {
      return markOffline(deviceId)
    } else return
  } else if (leaf === 'state') {
    const msg = parseJson(payload)
    if (!Array.isArray(msg?.ch)) return
    const ch = msg.ch.map((v) => (v ? 1 : 0))
    state = await upsertState(device, { $set: { channelStates: ch, online: true, lastSeen: now } })
    emit('device:state', stateView(state))
    if (msg.ack) await handleAck(deviceId, String(msg.ack), ch)
    const claimed = await DeviceState.findOneAndUpdate(
      { device: device._id, needsReconcile: true },
      { $set: { needsReconcile: false } }
    )
    if (claimed) await reconcileDevice(device, ch)
    return
  } else if (leaf === 'telemetry') {
    const t = parseJson(payload)
    if (!t) return
    const prev = await DeviceState.findOne({ device: device._id }, 'uptime').lean()
    const update = {
      $set: { online: true, lastSeen: now, rssi: t.rssi, uptime: t.uptime, heap: t.heap, fw: t.fw, rebootReason: t.reset },
    }
    // Firmware sends telemetry right after connecting, so an uptime that went down means a reboot.
    if (prev?.uptime != null && typeof t.uptime === 'number' && t.uptime < prev.uptime) {
      update.$push = { recentBoots: { $each: [now], $slice: -20 } }
    }
    state = await upsertState(device, update)
    if (t.fw && t.fw !== device.firmwareVersion) await Device.updateOne({ _id: device._id }, { $set: { firmwareVersion: t.fw } })
    // Firmware 1.2+ reports the build baked into its config.h (how a shared broker login tells builds apart)
    if (t.build && device.pendingBuild && String(device.pendingBuild) === t.build) {
      await markNewestFirmwareInstalled(await Device.findById(device._id).select('+pendingCredentialHash'))
    }
  }
  emit('device:state', stateView(state))
}

async function markOffline(deviceId) {
  const state = await DeviceState.findOneAndUpdate(
    { deviceId, online: true },
    { $set: { online: false } },
    { returnDocument: 'after' }
  ).lean()
  if (state) emit('device:state', stateView(state))
}

// After a restart nobody is known to be online yet: the built-in broker has no clients, and an external
// broker re-sends each board's retained status the moment this server subscribes.
export async function resetLiveState() {
  await DeviceState.updateMany({}, { $set: { online: false, needsReconcile: false } })
}
