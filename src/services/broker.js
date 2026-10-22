import net from 'node:net'
import { Aedes } from 'aedes'
import mqtt from 'mqtt'
import { Device } from '../models/index.js'
import { verifyDeviceSecret } from '../lib/crypto.js'
import { config } from '../config.js'
import { getSetting } from './settings.js'
import { markNewestFirmwareInstalled } from './firmware/installed.js'

// Two ways to run MQTT, same topics (acls/v1/{deviceId}/…) either way:
//  - built in (school PC): an embedded broker. Anonymous access is off; each device has its own
//    username + secret and may only use acls/v1/{deviceId}/#: publish state/status/telemetry/ota,
//    subscribe cmd. The backend publishes commands internally and never needs MQTT credentials.
//  - external (cloud, MQTT_URL set, e.g. HiveMQ Cloud over TLS): this server is a client of that
//    broker. The boards share one device login there; online/offline comes from their retained
//    status topic and Last Will.

const DEVICE_PUBLISH = new Set(['state', 'status', 'telemetry', 'ota'])
let aedes = null
let tcpServer = null
let client = null // external broker connection
const onlineExternal = new Set()

const authError = (code, msg) => Object.assign(new Error(msg), { returnCode: code })
const topicFor = (deviceId, leaf) => `${getSetting('topicRoot')}/${deviceId}/${leaf}`

export const usesExternalBroker = () => Boolean(config.externalMqtt)

export async function startBroker(handlers) {
  return config.externalMqtt ? connectExternal(handlers) : startEmbedded(handlers)
}

// Splits acls/v1/{deviceId}/{leaf} and hands device messages to the app, in arrival order per device.
function dispatcher(onMessage) {
  const prefixLen = getSetting('topicRoot').split('/').length
  return (topic, payload) => {
    const parts = topic.split('/')
    const deviceId = parts[prefixLen]
    const leaf = parts[prefixLen + 1]
    if (!DEVICE_PUBLISH.has(leaf)) return
    Promise.resolve(onMessage(deviceId, leaf, payload.toString())).catch((err) => console.error(`[mqtt] handling ${topic}:`, err))
  }
}

// ---- External broker (cloud) ----

async function connectExternal({ onMessage, onDisconnect }) {
  const ext = config.externalMqtt
  const root = getSetting('topicRoot')
  const dispatch = dispatcher(onMessage)
  client = mqtt.connect(ext.url, {
    username: ext.username || undefined,
    password: ext.password || undefined,
    clientId: `acls-server-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    keepalive: 30,
    reconnectPeriod: 5000,
    connectTimeout: 15000,
    ...(ext.ca ? { ca: ext.ca } : {}),
  })
  client.on('connect', () => {
    console.log(`[mqtt] connected to ${ext.host}:${ext.port}${ext.tls ? ' (TLS)' : ''}`)
    // Retained status/state arrive right away, so a restarted server knows at once who is online.
    client.subscribe(`${root}/+/+`, { qos: 0 }, (err) => err && console.error('[mqtt] subscribe failed:', err.message))
  })
  client.on('message', (topic, payload) => {
    const [, deviceId, leaf] = topic.slice(root.length).split('/')
    if (leaf === 'status') {
      if (payload.toString() === 'online') onlineExternal.add(deviceId)
      else if (payload.toString() === 'offline') {
        onlineExternal.delete(deviceId)
        onDisconnect(deviceId)
        return
      }
    }
    dispatch(topic, payload)
  })
  client.on('error', (err) => console.warn(`[mqtt] ${err.message}`))
  client.on('offline', () => console.warn('[mqtt] broker unreachable, retrying every 5 s'))
  // Don't block start-up: the website must work even while the broker is unreachable.
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 10000)
    client.once('connect', () => resolve(clearTimeout(t)))
  })
}

// ---- Built-in broker (school PC) ----

async function startEmbedded({ onMessage, onDisconnect }) {
  // Topic root is read once; changing it takes effect after a restart (and a re-flash).
  const root = getSetting('topicRoot')
  const port = config.mqttPort
  const dispatch = dispatcher(onMessage)
  aedes = await Aedes.createBroker({ drainTimeout: 30000, keepaliveLimit: 120 })

  aedes.authenticate = async (conn, username, password, cb) => {
    try {
      if (!username || !password) return cb(authError(4, 'Credentials required'), false)
      const device = await Device.findOne({ mqttUsername: username, status: { $ne: 'retired' } }).select('+credentialHash +pendingCredentialHash')
      const secret = password.toString()
      const current = device && verifyDeviceSecret(secret, device.credentialHash)
      const pending = device && !current && verifyDeviceSecret(secret, device.pendingCredentialHash)
      if (!current && !pending) {
        console.warn(`[mqtt] auth failed for "${username}" from ${conn.conn?.remoteAddress}`)
        return cb(authError(4, 'Bad username or password'), false)
      }
      if (conn.id !== device.deviceId) return cb(authError(2, 'Client ID must equal device ID'), false)
      conn.acls = { deviceId: device.deviceId, prefix: `${root}/${device.deviceId}/` }
      if (pending) await markNewestFirmwareInstalled(device)
      cb(null, true)
    } catch (err) {
      cb(err, false)
    }
  }

  aedes.authorizePublish = (conn, packet, cb) => {
    if (!conn) {
      // Stored Last Will published after the client is gone: only allow the status topic.
      const ok = new RegExp(`^${root}/acls-[0-9a-f]{6}/status$`).test(packet.topic)
      return cb(ok ? null : new Error('denied'))
    }
    const acl = conn.acls
    if (!acl || !packet.topic.startsWith(acl.prefix)) return cb(new Error('topic not allowed'))
    const leaf = packet.topic.slice(acl.prefix.length)
    cb(DEVICE_PUBLISH.has(leaf) ? null : new Error('topic not allowed'))
  }

  aedes.authorizeSubscribe = (conn, sub, cb) => {
    const allowed = conn.acls && sub.topic === `${conn.acls.prefix}cmd`
    if (!allowed) console.warn(`[mqtt] subscribe denied ${conn.id} -> ${sub.topic}`)
    cb(null, allowed ? sub : null)
  }

  aedes.on('clientDisconnect', (conn) => {
    if (!conn.acls) return
    // A reconnect with the same ID replaces the old session; don't mark that one offline.
    const current = aedes.clients[conn.id]
    if (current && current !== conn) return
    onDisconnect(conn.acls.deviceId)
  })

  aedes.on('clientError', (conn, err) => console.warn(`[mqtt] ${conn?.id}: ${err.message}`))

  await new Promise((resolve) =>
    aedes.subscribe(
      `${root}/+/+`,
      (packet, cb) => {
        dispatch(packet.topic, packet.payload)
        cb()
      },
      resolve
    )
  )

  tcpServer = net.createServer(aedes.handle)
  await new Promise((resolve) => tcpServer.listen(port, resolve))
  console.log(`[mqtt] broker listening on :${port} (topic root ${root})`)
}

export function publishCommand(deviceId, payload) {
  const topic = topicFor(deviceId, 'cmd')
  const body = Buffer.from(JSON.stringify(payload))
  return new Promise((resolve, reject) => {
    if (client) {
      if (!client.connected) return reject(new Error('MQTT broker not reachable'))
      return client.publish(topic, body, { qos: 0, retain: false }, (err) => (err ? reject(err) : resolve()))
    }
    aedes.publish({ cmd: 'publish', topic, payload: body, qos: 0, retain: false }, (err) => (err ? reject(err) : resolve()))
  })
}

export function isConnected(deviceId) {
  if (client) return onlineExternal.has(deviceId)
  return Boolean(aedes?.clients[deviceId]?.connected)
}

// Built-in broker only: with a shared device login there is no single board session to close.
export function kickDevice(deviceId) {
  aedes?.clients[deviceId]?.close()
}

export async function stopBroker() {
  if (client) await new Promise((r) => client.end(false, {}, () => r()))
  await new Promise((r) => (tcpServer ? tcpServer.close(() => r()) : r()))
  await new Promise((r) => (aedes ? aedes.close(() => r()) : r()))
}
