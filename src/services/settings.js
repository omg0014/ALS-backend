import os from 'node:os'
import { Device, Setting } from '../models/index.js'
import { config } from '../config.js'

// This PC's LAN IPv4 (what the boards connect to), so nobody has to type it in. Skips loopback,
// VPN/virtual adapters and non-private addresses; prefers the main Ethernet/WiFi adapter.
const VIRTUAL_IF = /^(lo|utun|tun|tap|ppp|ipsec|bridge|docker|br-|veth|vbox|vmnet|virbr|tailscale|zt|wg|awdl|llw|anpi)/i
const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
export function detectLanIp() {
  const found = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IF.test(name)) continue
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivate(a.address)) found.push({ name, ip: a.address })
    }
  }
  const main = found.find((f) => /^(en|eth|wlan|wl|Ethernet|Wi-?Fi)/i.test(f.name)) || found[0]
  return main ? main.ip : ''
}

// Global settings live in the database (PRD C5), never in code. These are first-run defaults.
export const SETTING_DEFS = {
  topicRoot: { default: 'acls/v1', type: 'string', label: 'MQTT topic root', reflash: true },
  brokerHost: { default: '', type: 'string', label: 'Broker address devices connect to (LAN IP of this server)', reflash: true },
  brokerPort: { default: 1883, type: 'number', label: 'Broker port', reflash: true },
  powerLossBehaviour: {
    default: 'restore',
    type: 'enum',
    options: ['restore', 'off'],
    label: 'After a power cut: restore last state from the database, or keep all OFF',
  },
  staggerMs: { default: 250, type: 'number', label: 'Stagger between ON commands in bulk actions (ms)', min: 0, max: 2000 },
  staggerOffMs: { default: 50, type: 'number', label: 'Stagger between OFF commands in bulk actions (ms)', min: 0, max: 2000 },
  confirmTimeoutMs: { default: 5000, type: 'number', label: 'Mark a command "not confirmed" after (ms)', min: 1000, max: 60000 },
  rssiAlertDbm: { default: -75, type: 'number', label: 'Weak WiFi alert below (dBm)' },
  offlineAlertMinutes: { default: 10, type: 'number', label: 'Offline alert after (minutes)', min: 1 },
  rebootAlertCount: { default: 3, type: 'number', label: 'Repeated reboot alert: reboots', min: 2 },
  rebootAlertWindowMinutes: { default: 60, type: 'number', label: 'Repeated reboot alert: within (minutes)', min: 5 },
}

const cache = new Map()

export async function loadSettings() {
  const rows = await Setting.find().lean()
  for (const [key, def] of Object.entries(SETTING_DEFS)) {
    const row = rows.find((r) => r.key === key)
    let value = row ? row.value : def.default
    if (config.externalMqtt) {
      // Cloud: the boards connect to the external broker (MQTT_URL), not to this server
      if (key === 'brokerHost') value = config.externalMqtt.host
      if (key === 'brokerPort') value = config.externalMqtt.port
    } else {
      // Not set by hand → BROKER_PUBLIC_HOST from .env, else this PC's own LAN address (found at start)
      if (key === 'brokerHost' && !value) value = config.brokerPublicHost || detectLanIp()
      // The port the devices use is the port this server's broker really listens on
      if (key === 'brokerPort' && !row) value = config.mqttPort
    }
    cache.set(key, value)
  }
}

// The devices have this address built into their firmware. If it changes (e.g. the router gives this PC a
// new IP), installed devices can no longer connect: flag them all "update needed" and say so in the log.
// Tip: give this PC a fixed address in the router so this never happens.
export async function trackServerAddress() {
  const host = getSetting('brokerHost')
  if (!host) {
    console.warn("[settings] could not find this PC's network address: connect it to the school network, or set BROKER_PUBLIC_HOST in backend/.env")
    return
  }
  const last = await Setting.findOne({ key: 'lastServerAddress' }).lean()
  if (last?.value === host) return
  await Setting.updateOne({ key: 'lastServerAddress' }, { $set: { value: host } }, { upsert: true })
  if (last?.value) {
    const r = await Device.updateMany(
      { status: { $ne: 'retired' } },
      { $push: { updateReasons: { reason: `This server's address changed from ${last.value} to ${host}`, at: new Date() } } }
    )
    console.warn(`[settings] server address changed ${last.value} → ${host}: ${r.modifiedCount} device(s) need a firmware update`)
  }
}

export function getSetting(key) {
  if (!(key in SETTING_DEFS)) throw new Error(`Unknown setting ${key}`)
  return cache.has(key) ? cache.get(key) : SETTING_DEFS[key].default
}

export function allSettings() {
  return Object.fromEntries(Object.keys(SETTING_DEFS).map((k) => [k, getSetting(k)]))
}

export function validateSetting(key, value) {
  const def = SETTING_DEFS[key]
  if (!def) return `Unknown setting ${key}`
  if (def.type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) return `${key} must be a number`
    if (def.min != null && value < def.min) return `${key} must be ≥ ${def.min}`
    if (def.max != null && value > def.max) return `${key} must be ≤ ${def.max}`
  }
  if (def.type === 'string' && typeof value !== 'string') return `${key} must be text`
  if (def.type === 'enum' && !def.options.includes(value)) return `${key} must be one of ${def.options.join(', ')}`
  if (key === 'topicRoot' && !/^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/i.test(value)) return 'topicRoot must look like acls/v1'
  return null
}

export async function setSetting(key, value) {
  await Setting.updateOne({ key }, { $set: { value } }, { upsert: true })
  cache.set(key, value)
}
