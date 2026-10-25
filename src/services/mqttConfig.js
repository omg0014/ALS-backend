import crypto from 'node:crypto'
import { Setting } from '../models/index.js'
import { config } from '../config.js'

// The external MQTT broker (cloud): from the server's environment (MQTT_URL…) when set, otherwise what
// an admin entered on the Settings page. Passwords are stored encrypted with a key derived from
// JWT_SECRET, and never sent back to the browser.

const KEY = 'mqttBroker'
let saved = null

const cipherKey = () => crypto.createHash('sha256').update(`acls-mqtt:${config.jwtSecret}`).digest()

export function encrypt(text) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv)
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

export function decrypt(blob) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'))
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(data), d.final()]).toString('utf8')
}

// Same shape as config.externalMqtt
export function brokerFrom({ host, port, tls, username, password, deviceUsername, devicePassword, deviceCa }) {
  const p = Number(port) || (tls ? 8883 : 1883)
  return {
    url: `${tls ? 'mqtts' : 'mqtt'}://${host}:${p}`,
    host,
    port: p,
    tls: Boolean(tls),
    username: username || '',
    password: password || '',
    ca: '',
    deviceUsername: deviceUsername || '',
    devicePassword: devicePassword || '',
    deviceCa: deviceCa || '',
  }
}

export async function loadMqttConfig() {
  const row = await Setting.findOne({ key: KEY }).lean()
  saved = null
  if (!row?.value) return
  try {
    saved = brokerFrom(JSON.parse(decrypt(row.value)))
  } catch {
    console.warn('[mqtt] the saved broker settings cannot be read (JWT_SECRET changed?): enter them again on the Settings page')
  }
}

export const mqttFromEnv = () => Boolean(config.externalMqtt)
export const externalMqtt = () => config.externalMqtt || saved

// Saves the broker; blank passwords keep the saved ones, so the form never has to show them.
export async function saveMqttConfig(input) {
  const merged = mergeWithSaved(input)
  await Setting.updateOne({ key: KEY }, { $set: { value: encrypt(JSON.stringify(merged)) } }, { upsert: true })
  saved = brokerFrom(merged)
  return saved
}

export function mergeWithSaved(input) {
  const host = String(input.host ?? '').trim().replace(/^mqtts?:\/\//, '').replace(/[:/].*$/, '')
  return {
    host,
    port: Number(input.port) || (input.tls ? 8883 : 1883),
    tls: Boolean(input.tls),
    username: String(input.username ?? '').trim(),
    password: input.password ? String(input.password) : (saved?.password ?? ''),
    deviceUsername: String(input.deviceUsername ?? '').trim(),
    devicePassword: input.devicePassword ? String(input.devicePassword) : (saved?.devicePassword ?? ''),
    deviceCa: String(input.deviceCa ?? '').trim(),
  }
}

export async function clearMqttConfig() {
  await Setting.deleteOne({ key: KEY })
  saved = null
}

// What the Settings page may see (no passwords)
export function mqttView() {
  const m = externalMqtt()
  if (!m) return { external: false, fromEnv: false }
  return {
    external: true,
    fromEnv: mqttFromEnv(),
    host: m.host,
    port: m.port,
    tls: m.tls,
    username: m.username,
    hasPassword: Boolean(m.password),
    deviceUsername: m.deviceUsername,
    hasDevicePassword: Boolean(m.devicePassword),
    deviceCa: m.deviceCa,
  }
}
