import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const here = path.dirname(fileURLToPath(import.meta.url))
const env = process.env

let jwtSecret = env.JWT_SECRET
if (!jwtSecret) {
  jwtSecret = crypto.randomBytes(32).toString('hex')
  console.warn('[config] JWT_SECRET not set: using a random secret, sessions end on restart')
}

// A PEM certificate given inline (Render/Vercel env vars) or as a file path.
function pem(value) {
  if (!value) return ''
  if (value.includes('-----BEGIN')) return value.replace(/\\n/g, '\n')
  return fs.readFileSync(value, 'utf8')
}

// MQTT_URL set → use that broker (e.g. HiveMQ Cloud, for a cloud deployment). Not set → the broker
// built into this server (school PC).
const mqttUrl = env.MQTT_URL ? new URL(env.MQTT_URL) : null

// The firmware template ships next to src/ in the backend-only repo, one level up in the full project.
const firmwareDir = [path.resolve(here, '../firmware'), path.resolve(here, '../../firmware')].find((d) => fs.existsSync(path.join(d, 'acls_firmware')))

export const config = {
  port: Number(env.PORT || 4000),
  mqttPort: Number(env.MQTT_PORT || 1883),
  // Built-in broker over TLS for boards on the internet (own server): port, certificate and key files,
  // and the root certificate the boards check it against (MQTT_DEVICE_CA). 0 = no TLS listener.
  mqttTls: {
    port: Number(env.MQTT_TLS_PORT || 0),
    cert: env.MQTT_TLS_CERT ? fs.readFileSync(env.MQTT_TLS_CERT, 'utf8') : '',
    key: env.MQTT_TLS_KEY ? fs.readFileSync(env.MQTT_TLS_KEY, 'utf8') : '',
    deviceCa: env.MQTT_URL ? '' : pem(env.MQTT_DEVICE_CA),
  },
  mongoUrl: env.MONGO_URL || env.MONGODB_URI || 'mongodb://127.0.0.1:27017/acls',
  jwtSecret,
  sessionHours: Number(env.SESSION_HOURS || 12),
  cookieSecure: env.COOKIE_SECURE === 'true',
  // Address devices use to reach the broker. Optional: when empty, the server's own LAN IP is used
  brokerPublicHost: env.BROKER_PUBLIC_HOST || '',
  // External broker (cloud). The server and the boards each have their own login there.
  externalMqtt: mqttUrl && {
    url: env.MQTT_URL,
    host: mqttUrl.hostname,
    port: Number(mqttUrl.port || (mqttUrl.protocol === 'mqtts:' ? 8883 : 1883)),
    tls: mqttUrl.protocol === 'mqtts:',
    username: env.MQTT_USERNAME || '',
    password: env.MQTT_PASSWORD || '',
    ca: pem(env.MQTT_CA), // only for a broker with a private certificate (tests); public CAs are trusted already
    deviceUsername: env.MQTT_DEVICE_USERNAME || '',
    devicePassword: env.MQTT_DEVICE_PASSWORD || '',
    deviceCa: pem(env.MQTT_DEVICE_CA), // root certificate the boards check the broker against
  },
  // Running in the cloud (Render sets RENDER=true): no LAN broker here, boards need an external one
  cloud: Boolean(env.RENDER) || env.CLOUD === 'true',
  // Public address of this server (https://….onrender.com): boards download WiFi updates from here
  publicUrl: (env.PUBLIC_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/$/, ''),
  firmwareDir: env.FIRMWARE_DIR || firmwareDir || path.resolve(here, '../../firmware'),
  // arduino-cli + board cores installed by `npm run toolchain:install` (no Docker)
  arduinoToolsDir: env.ARDUINO_TOOLS_DIR || path.resolve(here, '../tools'),
  // Compiled firmware waiting to be flashed (USB) or downloaded by a board (OTA); removed after 24 h
  buildsDir: env.BUILDS_DIR || path.resolve(here, '../data/builds'),
  webDist: env.WEB_DIST || path.resolve(here, '../../frontend/dist'),
  // Websites allowed to use the live updates from another address (the Vercel site), comma separated
  // (a trailing "/" is ignored: browsers send the address without it)
  corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  // Proxies in front of the API (e.g. 1 behind a reverse proxy), used for client IPs in the audit log
  trustProxy: /^\d+$/.test(env.TRUST_PROXY ?? '') ? Number(env.TRUST_PROXY) : env.TRUST_PROXY || 'loopback',
}

if (config.externalMqtt && (!config.externalMqtt.deviceUsername || !config.externalMqtt.devicePassword)) {
  console.warn('[config] MQTT_URL is set but MQTT_DEVICE_USERNAME / MQTT_DEVICE_PASSWORD are not: firmware cannot be generated')
}
