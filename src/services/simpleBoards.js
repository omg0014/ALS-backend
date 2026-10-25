import mqtt from 'mqtt'
import { Channel, Command, Device, DeviceState } from '../models/index.js'
import { decrypt } from './mqttConfig.js'
import { emit } from './realtime.js'
import { stateView } from './deviceEvents.js'

// Simple MQTT boards: boards that run their own code (e.g. "send ON to rawniee/test/r4"). The website
// publishes their ON or OFF message to their command topic on their broker, and reads their state
// topic (if they have one) to confirm. One connection per broker + login, shared by its boards.
// "Connected" means their broker is reachable: their own code does not report online/offline.

const pools = new Map() // poolKey -> { client, devices: Set<deviceId> }
const boards = new Map() // deviceId -> board settings (password decrypted)
let hooks = null // { handleAck, reconcileDevice }: from commands.js (avoids an import cycle)

const poolKey = (b) => `${b.url}|${b.username ?? ''}`
const same = (a, b) => String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase()

export const isSimpleId = (deviceId) => String(deviceId).startsWith('mqtt-')

function toBoard(device) {
  const s = device.simple ?? {}
  let password = ''
  try {
    password = s.passwordEnc ? decrypt(s.passwordEnc) : ''
  } catch {
    console.warn(`[simple] ${device.deviceId}: saved password cannot be read (JWT_SECRET changed?), enter it again`)
  }
  return { _id: device._id, deviceId: device.deviceId, name: device.name, ...s, password }
}

export async function startSimpleBoards(h) {
  hooks = h
  const devices = await Device.find({ kind: 'simple', status: 'active' }).select('+simple.passwordEnc').lean()
  for (const d of devices) attach(toBoard(d))
  if (devices.length) console.log(`[simple] ${devices.length} simple MQTT board(s) on ${pools.size} broker(s)`)
}

// After a board is added, edited or removed: drop its old connection settings, attach the new ones.
export async function refreshSimpleBoard(deviceId) {
  detach(deviceId)
  const d = await Device.findOne({ deviceId, kind: 'simple', status: 'active' }).select('+simple.passwordEnc').lean()
  if (d) attach(toBoard(d))
}

function attach(board) {
  boards.set(board.deviceId, board)
  const key = poolKey(board)
  let pool = pools.get(key)
  if (!pool) {
    pool = { client: connect(board, key), devices: new Set() }
    pools.set(key, pool)
  }
  pool.devices.add(board.deviceId)
  if (pool.client.connected) onPoolConnect(pool, [board.deviceId])
}

function detach(deviceId) {
  const board = boards.get(deviceId)
  if (!board) return
  boards.delete(deviceId)
  const key = poolKey(board)
  const pool = pools.get(key)
  if (!pool) return
  pool.devices.delete(deviceId)
  if (board.stateTopic && ![...pool.devices].some((id) => boards.get(id)?.stateTopic === board.stateTopic)) pool.client.unsubscribe(board.stateTopic)
  if (!pool.devices.size) {
    pool.client.end(true)
    pools.delete(key)
  }
}

function connect(board, key) {
  const client = mqtt.connect(board.url, {
    username: board.username || undefined,
    password: board.password || undefined,
    clientId: `acls-web-${Math.random().toString(16).slice(2, 10)}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
  })
  client.on('connect', () => {
    const pool = pools.get(key)
    if (pool) onPoolConnect(pool, [...pool.devices])
  })
  client.on('close', () => {
    const pool = pools.get(key)
    if (pool) for (const id of pool.devices) markOffline(id)
  })
  client.on('error', (err) => console.warn(`[simple] ${board.url}: ${err.message}`))
  client.on('message', (topic, payload) => {
    const pool = pools.get(key)
    if (!pool) return
    for (const id of pool.devices) {
      const b = boards.get(id)
      if (b?.stateTopic === topic) onState(b, payload.toString()).catch((err) => console.error('[simple]', err))
    }
  })
  return client
}

// Broker reachable: the board counts as connected, and its retained state (if any) arrives next.
async function onPoolConnect(pool, ids) {
  for (const id of ids) {
    const b = boards.get(id)
    if (!b) continue
    if (b.stateTopic) pool.client.subscribe(b.stateTopic)
    const st = await DeviceState.findOneAndUpdate(
      { device: b._id },
      { $set: { online: true, lastSeen: new Date(), onlineSince: new Date(), needsReconcile: Boolean(b.stateTopic && b.synced) }, $setOnInsert: { deviceId: b.deviceId } },
      { upsert: true, returnDocument: 'after' }
    ).lean()
    emit('device:state', stateView(st))
  }
}

async function markOffline(deviceId) {
  const st = await DeviceState.findOneAndUpdate({ deviceId, online: true }, { $set: { online: false } }, { returnDocument: 'after' }).lean()
  if (st) emit('device:state', stateView(st))
}

// The board reported ON or OFF on its state topic.
async function onState(b, payload) {
  const on = same(payload, b.onPayload)
  if (!on && !same(payload, b.offPayload)) return
  const ch = [on ? 1 : 0]
  const st = await DeviceState.findOneAndUpdate(
    { device: b._id },
    { $set: { channelStates: ch, online: true, lastSeen: new Date() }, $setOnInsert: { deviceId: b.deviceId } },
    { upsert: true, returnDocument: 'after' }
  ).lean()
  emit('device:state', stateView(st))

  const pending = await Command.findOne({ deviceId: b.deviceId, channel: 1, result: { $in: ['pending', 'not_confirmed'] } }).sort({ createdAt: -1 }).lean()
  if (!b.synced) {
    b.synced = true
    await Device.updateOne({ _id: b._id }, { $set: { 'simple.synced': true } })
  }
  if (pending) return hooks?.handleAck(b.deviceId, pending.cmdId, ch)
  if (!st.needsReconcile) {
    // First report, or switched from somewhere else (another MQTT app): that is how the room is now
    return Channel.updateOne({ device: b._id, index: 1 }, { $set: { desiredState: ch[0] } })
  }
  const claimed = await DeviceState.findOneAndUpdate({ device: b._id, needsReconcile: true }, { $set: { needsReconcile: false } })
  if (claimed) {
    const device = await Device.findById(b._id).lean()
    return hooks?.reconcileDevice(device, ch)
  }
  // Switched from somewhere else (another MQTT app): take it as the new wanted state
  await Channel.updateOne({ device: b._id, index: 1 }, { $set: { desiredState: ch[0] } })
}

// Sends ON/OFF. Returns true when the board has no state topic (nothing will confirm it).
export function publishSimple(deviceId, desired) {
  const b = boards.get(deviceId)
  const pool = b && pools.get(poolKey(b))
  return new Promise((resolve, reject) => {
    if (!pool?.client.connected) return reject(new Error('Broker of this board not reachable'))
    const message = desired === 'ON' ? b.onPayload : b.offPayload
    pool.client.publish(b.commandTopic, message, { qos: 0, retain: Boolean(b.retain) }, (err) => (err ? reject(err) : resolve(!b.stateTopic)))
  })
}

// "Test" on the form: log in, and read the board's current state if it reports one (3 s).
export function testSimpleBoard({ url, username, password, stateTopic }) {
  return new Promise((resolve) => {
    const c = mqtt.connect(url, {
      username: username || undefined,
      password: password || undefined,
      clientId: `acls-test-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 0,
      connectTimeout: 10000,
    })
    let state = null
    const done = (r) => {
      clearTimeout(timer)
      c.end(true)
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, error: 'No answer from the broker within 10 seconds' }), 11000)
    c.once('error', (err) => done({ ok: false, error: err.message }))
    c.once('connect', () => {
      if (!stateTopic) return done({ ok: true, state })
      c.subscribe(stateTopic)
      c.on('message', (t, p) => t === stateTopic && (state = p.toString()))
      setTimeout(() => done({ ok: true, state }), 3000)
    })
  })
}

export async function stopSimpleBoards() {
  for (const pool of pools.values()) pool.client.end(true)
  pools.clear()
  boards.clear()
}
