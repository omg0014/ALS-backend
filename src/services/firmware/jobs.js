import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { Channel, Device, FirmwareBuild, Room } from '../../models/index.js'
import { badRequest, conflict } from '../../lib/errors.js'
import { generateDeviceSecret, hashDeviceSecret, newId } from '../../lib/crypto.js'
import { arduinoSteps, buildConfigHeader, expectedBootLog, packageReadme, readFirmwareFile, templateVersion } from '../../lib/firmware/index.js'
import { createZip } from '../../lib/zip.js'
import { config } from '../../config.js'
import { actorOf, logChange } from '../changeLog.js'
import { allSettings } from '../settings.js'
import { emit } from '../realtime.js'
import { compileSketch, toolchainReady } from './builder.js'
import { externalMqtt } from '../mqttConfig.js'
import { publishCommand } from '../broker.js'

const OTA_TOKEN_MS = 15 * 60 * 1000
const OTA_DONE_TIMEOUT_MS = 5 * 60 * 1000
const buildEvent = (build) => emit('build', { buildId: String(build._id), device: build.device ? String(build.device) : null })

// How boards log in to an external broker (cloud): one shared device login over TLS. Undefined with the
// built-in broker, where each board has its own secret.
export function deviceMqttOptions() {
  const ext = externalMqtt()
  if (!ext) {
    if (config.cloud) throw badRequest('Enter the MQTT broker on the Settings page first: the boards need it to connect.')
    // Own server on the internet: the built-in broker over TLS, each board with its own login
    if (config.mqttTls.port) return { tls: true, ca: config.mqttTls.deviceCa, perDevice: true }
    return undefined
  }
  if (!ext.deviceUsername || !ext.devicePassword) throw badRequest('The MQTT broker has no board login yet: add it on the Settings page.')
  return { tls: ext.tls, ca: ext.deviceCa, username: ext.deviceUsername, password: ext.devicePassword }
}

// Where a board downloads a WiFi update: this server's public address (cloud), else its LAN address.
export function otaBaseUrl() {
  if (config.publicUrl) return config.publicUrl
  if (externalMqtt()) throw badRequest('PUBLIC_URL is not set on the server, so boards cannot download updates')
  return `http://${allSettings().brokerHost}:${config.port}`
}

// New firmware package for a device. Its secret is "pending": the running board keeps working until
// a board logs in with it (see broker promoteCredentials).
export async function generateFirmware(req, device, { wifiSsid, wifiPassword }) {
  if (device.status === 'retired') throw conflict('Device is retired')
  if (device.kind === 'simple') throw badRequest('This board runs its own code: the website does not make firmware for it')
  wifiSsid = String(wifiSsid ?? '').trim()
  wifiPassword = String(wifiPassword ?? '')
  if (!wifiSsid) throw badRequest('WiFi name is required')
  if (!wifiPassword) throw badRequest('WiFi password is required: without it the board cannot join the WiFi')
  const settings = { ...allSettings(), firmwareVersion: templateVersion() }
  if (!settings.brokerHost) throw badRequest("Could not find this server's network address. Connect this PC to the school network and restart the server.")

  const profile = device.profile
  const [channels, room] = await Promise.all([
    Channel.find({ device: device._id }).lean(),
    device.room ? Room.findById(device.room) : null,
  ])
  const secret = generateDeviceSecret()
  const buildId = new mongoose.Types.ObjectId()
  const mqtt = deviceMqttOptions()
  const configH = buildConfigHeader({ device, profile, channels, room, settings, secret, wifiSsid, wifiPassword, mqtt, buildId: String(buildId) })
  const files = [
    { path: 'acls_firmware/acls_firmware.ino', content: readFirmwareFile('acls_firmware', 'acls_firmware.ino') },
    { path: 'acls_firmware/config.h', content: configH },
    { path: 'README.txt', content: packageReadme({ device, profile, room, settings, wifiSsid }) },
  ]

  const build = await FirmwareBuild.create({
    _id: buildId,
    kind: 'firmware',
    device: device._id,
    deviceId: device.deviceId,
    profile: profile._id,
    profileCode: `${profile.code} v${profile.version}`,
    version: settings.firmwareVersion,
    configHash: crypto.createHash('sha256').update(configH).digest('hex'),
    configRedacted: configH.replace(/(#define MQTT_PASSWORD )".*"/, '$1"<redacted>"').replace(/(#define WIFI_PASSWORD )".*"/, '$1"<redacted>"'),
    wifiSsid,
    createdBy: actorOf(req),
  })

  const now = new Date()
  await Device.updateOne(
    { _id: device._id },
    {
      $set: { pendingCredentialHash: hashDeviceSecret(secret), pendingIssuedAt: now, pendingBuild: build._id },
      $push: { updateReasons: { reason: `Firmware ${settings.firmwareVersion} generated: upload it to the board`, at: now } },
    }
  )
  if (room && room.wifiSsid !== wifiSsid) {
    room.wifiSsid = wifiSsid
    await room.save()
  }
  await logChange(req, 'device', 'update', { _id: device._id, firmware: 'previous' }, { _id: device._id, firmware: `build ${build._id} (${settings.firmwareVersion})` })
  emit('devices:changed', {})

  return {
    build,
    files,
    zipName: `${device.deviceId}_firmware.zip`,
    zipBase64: createZip(files).toString('base64'),
    steps: arduinoSteps(profile.espModel),
    bootLog: expectedBootLog({ profile, deviceId: device.deviceId, wifiSsid, settings, channels: channels.length }),
  }
}

// Compile on this server (USB upload or OTA). Resolves when the build finished.
export async function compileBuild(build, espModel, files) {
  build.compile = { status: 'queued' }
  await build.save()
  buildEvent(build)
  const sketchFiles = files.filter((f) => f.path.endsWith('.ino') || f.path.endsWith('.h'))
  const r = await compileSketch({
    buildId: build._id,
    espModel,
    files: sketchFiles,
    onStart: () => {
      FirmwareBuild.updateOne({ _id: build._id }, { $set: { 'compile.status': 'compiling', 'compile.startedAt': new Date() } })
        .then(() => buildEvent(build))
        .catch(() => {})
    },
  })
  const update = { status: r.ok ? 'ready' : 'failed', log: r.log, finishedAt: new Date(), usb: r.usb, ota: r.ota }
  const startedAt = (await FirmwareBuild.findById(build._id, 'compile.startedAt').lean())?.compile?.startedAt
  build.compile = { ...update, startedAt }
  await build.save()
  buildEvent(build)
  return r.ok
}

// ---- Over-the-air update ----

const versionAtLeast = (v, min) => {
  const a = String(v || '0').split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  return true
}

export const OTA_MIN_VERSION = '1.1.0'
const OTA_HTTPS_MIN_VERSION = '1.2.0' // downloads from an https:// address (cloud server)

export function otaBlocker(device, state) {
  if (!toolchainReady()) return 'This server has no firmware build tools, so it cannot prepare a WiFi update. Download the firmware for Arduino IDE instead.'
  if (!device.firmwareVersion) return 'This board has not run ACLS firmware yet. Upload it once by USB first.'
  const min = config.publicUrl.startsWith('https:') ? OTA_HTTPS_MIN_VERSION : OTA_MIN_VERSION
  if (!versionAtLeast(device.firmwareVersion, min)) {
    return `The board runs firmware ${device.firmwareVersion || 'unknown'}, which cannot update over WiFi from this server. Upload ${min} or newer once by USB.`
  }
  if (!state?.online) return 'The board is offline'
  return null
}

export async function startOta(req, device, state, wifi) {
  const blocker = otaBlocker(device, state)
  if (blocker) throw badRequest(blocker)
  const pkg = await generateFirmware(req, device, wifi)
  pkg.build.ota = { status: 'waiting_build' }
  await pkg.build.save()
  compileBuild(pkg.build, device.profile.espModel, pkg.files)
    .then((ok) => (ok ? sendOta(pkg.build._id) : failOta(pkg.build._id, 'Compile failed')))
    .catch((err) => failOta(pkg.build._id, err.message))
    .catch((err) => console.error('[ota]', err.message))
  return pkg.build
}

async function sendOta(buildId) {
  const build = await FirmwareBuild.findById(buildId)
  const token = crypto.randomBytes(24).toString('hex')
  build.ota = { status: 'sent', token, tokenExpires: new Date(Date.now() + OTA_TOKEN_MS), sentAt: new Date() }
  await build.save()
  const url = `${otaBaseUrl()}/ota/${token}`
  await publishCommand(build.deviceId, { id: newId(6), ota: url })
  buildEvent(build)
  setTimeout(
    () => failOta(buildId, 'The board did not come back with the new firmware within 5 minutes', ['sent', 'downloading', 'started']).catch((err) => console.error('[ota]', err.message)),
    OTA_DONE_TIMEOUT_MS
  )
}

async function failOta(buildId, error, onlyFrom = ['waiting_build', 'sent', 'downloading', 'started']) {
  const build = await FirmwareBuild.findOneAndUpdate(
    { _id: buildId, 'ota.status': { $in: onlyFrom } },
    { $set: { 'ota.status': 'failed', 'ota.error': error } },
    { returnDocument: 'after' }
  )
  if (build) buildEvent(build)
}

// GET /ota/:token, fetched by the board itself (ESP HTTP update, checks x-MD5).
export async function otaDownload(token) {
  const build = await FirmwareBuild.findOne({ 'ota.token': token, 'ota.tokenExpires': { $gt: new Date() }, 'ota.status': { $in: ['sent', 'downloading'] } })
  if (!build) return null
  build.ota.status = 'downloading'
  await build.save()
  buildEvent(build)
  return build
}

// Board reports on acls/v1/{id}/ota: {"result":"started"} before flashing, {"result":"failed","error":...} on failure.
export async function onOtaReport(deviceId, payload) {
  let msg
  try {
    msg = JSON.parse(payload)
  } catch {
    return
  }
  const device = await Device.findOne({ deviceId }, 'pendingBuild').lean()
  if (!device?.pendingBuild) return
  if (msg.result === 'started') {
    const b = await FirmwareBuild.findOneAndUpdate(
      { _id: device.pendingBuild, 'ota.status': { $in: ['sent', 'downloading'] } },
      { $set: { 'ota.status': 'started' } },
      { returnDocument: 'after' }
    )
    if (b) buildEvent(b)
  } else if (msg.result === 'failed') {
    await failOta(device.pendingBuild, `Board: ${msg.error || 'update failed'}`)
  }
}

// After a restart nothing is compiling or updating any more: say so instead of showing "compiling" forever.
export async function closeStaleBuilds() {
  const now = new Date()
  await FirmwareBuild.updateMany(
    { 'compile.status': { $in: ['queued', 'compiling'] } },
    { $set: { 'compile.status': 'failed', 'compile.log': 'The server restarted during the build. Please build again.', 'compile.finishedAt': now } }
  )
  await FirmwareBuild.updateMany(
    { 'ota.status': { $in: ['waiting_build', 'sent', 'downloading'] } },
    { $set: { 'ota.status': 'failed', 'ota.error': 'The server restarted during the update. Please start it again.' } }
  )
}
