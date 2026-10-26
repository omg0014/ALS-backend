import fs from 'node:fs'
import { Router } from 'express'
import { Channel, Device, DeviceState, FirmwareBuild, HardwareProfile, LightingGroup, Room } from '../models/index.js'
import { EDITOR } from '../lib/auth.js'
import { badRequest, notFound } from '../lib/errors.js'
import { normaliseDeviceId } from '../lib/deviceId.js'
import { pinLabel } from '../lib/hardwareRules.js'
import { allSettings } from '../services/settings.js'
import { loadWarnings } from '../lib/hardwareRules.js'
import { TOOLCHAIN, arduinoSteps, benchChecklist, buildConfigHeader, readFirmwareFile, templateVersion, testSketches, wiringPlan } from '../lib/firmware/index.js'
import { createZip } from '../lib/zip.js'
import { actorOf } from '../services/changeLog.js'
import { binPath, queueLength, toolchainReady } from '../services/firmware/builder.js'
import { OTA_MIN_VERSION, compileBuild, deviceMqttOptions, generateFirmware, otaBlocker, startOta } from '../services/firmware/jobs.js'

const router = Router()

async function groupsMap(ids) {
  const groups = await LightingGroup.find({ _id: { $in: ids.filter(Boolean) } }).lean()
  return new Map(groups.map((g) => [String(g._id), g]))
}

// ---- Info and plans ----

router.get('/firmware/info', (req, res) => {
  res.json({
    version: templateVersion(),
    toolchain: TOOLCHAIN,
    buildService: { ready: toolchainReady(), queue: queueLength() },
    otaMinVersion: OTA_MIN_VERSION,
    steps: { esp32: arduinoSteps('esp32'), esp8266: arduinoSteps('esp8266') },
  })
})

// Wiring table, warnings and checklist for a profile + channel mapping (used before the device exists).
router.post('/firmware/plan', async (req, res) => {
  const profile = await HardwareProfile.findById(req.body?.profile).lean()
  if (!profile) throw badRequest('Choose a hardware profile')
  const channels = (req.body.channels ?? profile.pins.map((p, i) => ({ index: i + 1, gpio: p.gpio }))).map((c) => ({
    index: Number(c.index),
    gpio: Number(c.gpio),
    lightingGroup: c.lightingGroup || null,
  }))
  const groupsById = await groupsMap(channels.map((c) => c.lightingGroup))
  res.json({
    plan: wiringPlan({ profile, channels, groupsById }),
    warnings: channels.flatMap((c) => loadWarnings(profile, groupsById.get(String(c.lightingGroup))).map((w) => `IN${c.index}: ${w}`)),
    setupNotes: profile.setupNotes,
    checklist: benchChecklist(profile),
  })
})

router.get('/devices/:id/wiring', async (req, res) => {
  const device = await Device.findById(req.params.id).populate('profile').populate({ path: 'room', populate: 'floor' }).lean()
  if (!device) throw notFound('Device not found')
  const channels = await Channel.find({ device: device._id }).sort({ index: 1 }).lean()
  const groupsById = await groupsMap(channels.map((c) => c.lightingGroup))
  res.json({ device, plan: wiringPlan({ profile: device.profile, channels, groupsById }), checklist: benchChecklist(device.profile) })
})

router.get('/firmware/chip-id-sketch', (req, res) => {
  const content = readFirmwareFile('tools', 'chip_id', 'chip_id.ino')
  res.json({ filename: 'chip_id/chip_id.ino', content, zipName: 'chip_id.zip', zipBase64: createZip([{ path: 'chip_id/chip_id.ino', content }]).toString('base64') })
})

// ---- Code preview: exactly what will be uploaded, from what the user entered (nothing is saved) ----

// Same config.h the upload will use, with the two secrets hidden: the device password does not exist yet
// (it is created at upload) and the WiFi password is never shown back.
router.post('/firmware/preview', EDITOR, async (req, res) => {
  const b = req.body ?? {}
  const existing = b.device ? await Device.findById(b.device).lean() : null
  const profile = await HardwareProfile.findById(b.profile ?? existing?.profile).lean()
  if (!profile) throw badRequest('Choose the relay board first')
  const deviceId = existing?.deviceId ?? (b.chipId ? normaliseDeviceId(b.chipId) : 'acls-??????')
  const name = String(b.name || existing?.name || 'New device')
  const room = await Room.findById(b.room ?? existing?.room).lean()
  const channels = profile.pins.slice(0, profile.channels).map((p, i) => {
    const c = (b.channels ?? []).find((x) => Number(x.index) === i + 1) ?? {}
    return { index: i + 1, gpio: Number(c.gpio ?? p.gpio), lightingGroup: c.lightingGroup || null }
  })
  const groups = new Map((await LightingGroup.find({ _id: { $in: channels.map((c) => c.lightingGroup).filter(Boolean) } }).lean()).map((g) => [String(g._id), g]))
  const settings = { ...allSettings(), firmwareVersion: templateVersion() }
  const mqtt = deviceMqttOptions()
  const wifiSsid = String(b.wifiSsid ?? '').replace(/[\r\n]/g, '')
  const configH = buildConfigHeader({
    device: { name, deviceId, mqttUsername: deviceId },
    profile,
    channels,
    room,
    settings,
    secret: '(created when you upload)',
    wifiSsid,
    wifiPassword: b.wifiPassword ? '•'.repeat(Math.min(String(b.wifiPassword).length, 16)) : '',
    mqtt: mqtt && { ...mqtt, password: '(hidden)' },
    buildId: '(set when you upload)',
  })
  const on = profile.trigger
  res.json({
    version: settings.firmwareVersion,
    summary: [
      `Board ${deviceId} (${profile.espModel === 'esp32' ? 'ESP32' : 'NodeMCU'}) named "${name}"${room ? ` in ${room.displayName}` : ''}.`,
      wifiSsid ? `Joins the WiFi "${wifiSsid}"${b.wifiPassword ? ' with the password you typed' : ' (type its password above)'}.` : 'Joins the WiFi you enter.',
      mqtt?.perDevice
        ? `Connects to this server at ${settings.brokerHost}:${settings.brokerPort} over an encrypted (TLS) connection with its own private login.`
        : mqtt
        ? `Connects to the MQTT broker ${settings.brokerHost}:${settings.brokerPort}${mqtt.tls ? ' over an encrypted (TLS) connection' : ''} with the device login.`
        : `Connects to this server at ${settings.brokerHost || '(address not found)'}:${settings.brokerPort} with its own private login.`,
      ...channels.map(
        (c) =>
          `Relay ${c.index} (pin ${pinLabel(profile.espModel, c.gpio)}) switches ${groups.get(String(c.lightingGroup))?.name ? `"${groups.get(String(c.lightingGroup)).name}"` : 'nothing (spare)'}; the relay is ON when the pin is ${on}.`
      ),
      'At power-up every relay starts OFF; the server then switches each one back to how it was.',
      'Reports to the website every minute (online, WiFi signal, firmware version) and can be updated over WiFi later.',
    ],
    files: [
      { name: 'config.h', note: 'Your settings, made from what you entered', content: configH },
      { name: 'acls_firmware.ino', note: 'The program (the same for every board)', content: readFirmwareFile('acls_firmware', 'acls_firmware.ino') },
    ],
  })
})

// ---- Production firmware (website upload over USB / WiFi, Arduino IDE zip as fallback) ----

const buildView = (b) => ({
  _id: b._id,
  kind: b.kind,
  sketch: b.sketch,
  device: b.device,
  deviceId: b.deviceId,
  profileCode: b.profileCode,
  version: b.version,
  wifiSsid: b.wifiSsid,
  createdAt: b.createdAt,
  createdBy: b.createdBy,
  configHash: b.configHash,
  configRedacted: b.configRedacted, // secrets replaced by <redacted>
  compile: b.compile ? { status: b.compile.status, log: b.compile.log, startedAt: b.compile.startedAt, finishedAt: b.compile.finishedAt, usb: b.compile.usb, ota: b.compile.ota } : null,
  ota: b.ota ? { status: b.ota.status, sentAt: b.ota.sentAt, doneAt: b.ota.doneAt, error: b.ota.error } : null,
  installedAt: b.installedAt,
  binaryAvailable: b.compile?.status === 'ready' && fs.existsSync(binPath(b._id, 'usb')),
})

async function loadDeviceWithProfile(id) {
  const device = await Device.findById(id).populate('profile')
  if (!device) throw notFound('Device not found')
  return device
}

// New firmware for the board (new pending secret, WiFi baked in) as a zip; with compile: true the
// website also builds it so it can be uploaded over USB from this site.
router.post('/devices/:id/firmware', EDITOR, async (req, res) => {
  const device = await loadDeviceWithProfile(req.params.id)
  const pkg = await generateFirmware(req, device, req.body ?? {})
  const compile = Boolean(req.body?.compile)
  if (compile) {
    if (!toolchainReady()) throw badRequest('The build toolchain is not installed on the server (npm run toolchain:install). Use the zip with Arduino IDE meanwhile.')
    compileBuild(pkg.build, device.profile.espModel, pkg.files).catch((err) => console.error('[build]', err))
  }
  res.json({
    buildId: pkg.build._id,
    compiling: compile,
    zipName: pkg.zipName,
    zipBase64: pkg.zipBase64,
    files: pkg.files,
    steps: pkg.steps,
    bootLog: pkg.bootLog,
    espModel: device.profile.espModel,
    deviceId: device.deviceId,
    profileVerified: device.profile.verified,
  })
})

// Over-the-air: generate, compile, and tell the running board (firmware >= 1.1.0) to download it.
router.post('/devices/:id/ota', EDITOR, async (req, res) => {
  const device = await loadDeviceWithProfile(req.params.id)
  if (!toolchainReady()) throw badRequest('The build toolchain is not installed on the server (npm run toolchain:install)')
  const state = await DeviceState.findOne({ device: device._id }).lean()
  const build = await startOta(req, device, state, req.body ?? {})
  res.status(202).json(buildView(build))
})

router.get('/devices/:id/ota-check', async (req, res) => {
  const device = await Device.findById(req.params.id).lean()
  if (!device) throw notFound('Device not found')
  const state = await DeviceState.findOne({ device: device._id }).lean()
  res.json({ blocker: !toolchainReady() ? 'The build toolchain is not installed on the server' : otaBlocker(device, state), minVersion: OTA_MIN_VERSION })
})

router.get('/devices/:id/builds', async (req, res) => {
  const builds = await FirmwareBuild.find({ device: req.params.id, kind: 'firmware' }).sort({ createdAt: -1 }).limit(20).lean()
  res.json(builds.map(buildView))
})

router.get('/builds/:id', async (req, res) => {
  const build = await FirmwareBuild.findById(req.params.id).lean()
  if (!build) throw notFound('Build not found')
  res.json(buildView(build))
})

// The code a build put on the board: its config.h (passwords hidden) and the program, while it is still this version.
router.get('/builds/:id/code', async (req, res) => {
  const build = await FirmwareBuild.findById(req.params.id).lean()
  if (!build || build.kind !== 'firmware') throw notFound('Build not found')
  const files = [{ name: 'config.h', note: 'The settings this board got', content: build.configRedacted ?? '' }]
  const current = build.version === templateVersion()
  if (current) files.push({ name: 'acls_firmware.ino', note: 'The program (the same for every board)', content: readFirmwareFile('acls_firmware', 'acls_firmware.ino') })
  res.json({ version: build.version, programShown: current, files })
})

// Binary for USB upload from the browser (contains secrets: editors only, deleted after 24 h).
router.get('/builds/:id/usb.bin', EDITOR, async (req, res) => {
  const build = await FirmwareBuild.findById(req.params.id).lean()
  const file = build && binPath(build._id, 'usb')
  if (!build || build.compile?.status !== 'ready' || !fs.existsSync(file)) throw notFound('Binary not available (build again)')
  res.set('Cache-Control', 'no-store')
  res.set('X-Flash-Offset', String(build.compile.usb?.offset ?? 0))
  res.type('application/octet-stream').sendFile(file)
})

// ---- Test sketches (C3) ----

async function sketchChannels(profile, deviceId) {
  if (deviceId) {
    const own = await Channel.find({ device: deviceId }).sort({ index: 1 }).lean()
    if (own.length) return own
  }
  return profile.pins.slice(0, profile.channels).map((p, i) => ({ index: i + 1, gpio: p.gpio }))
}

router.post('/profiles/:id/test-sketches', async (req, res) => {
  const profile = await HardwareProfile.findById(req.params.id).lean()
  if (!profile) throw notFound('Profile not found')
  const channels = await sketchChannels(profile, req.body?.device)
  const sketches = testSketches({ profile, channels, wifiSsid: req.body?.wifiSsid, wifiPassword: req.body?.wifiPassword })
  res.json({
    sketches,
    zipName: `${profile.code}_test_sketches.zip`,
    zipBase64: createZip(sketches.map((s) => ({ path: s.filename, content: s.content }))).toString('base64'),
    steps: arduinoSteps(profile.espModel),
    canCompile: toolchainReady(),
  })
})

// Compile one test sketch on the server so it can be uploaded over USB from the website.
router.post('/profiles/:id/test-sketches/:kind/build', EDITOR, async (req, res) => {
  const profile = await HardwareProfile.findById(req.params.id).lean()
  if (!profile) throw notFound('Profile not found')
  if (!toolchainReady()) throw badRequest('The build toolchain is not installed on the server (npm run toolchain:install)')
  const channels = await sketchChannels(profile, req.body?.device)
  const sketch = testSketches({ profile, channels, wifiSsid: req.body?.wifiSsid, wifiPassword: req.body?.wifiPassword }).find((x) => x.kind === req.params.kind)
  if (!sketch) throw notFound('Unknown test sketch')
  const build = await FirmwareBuild.create({
    kind: 'test_sketch',
    sketch: sketch.kind,
    device: req.body?.device || undefined,
    profile: profile._id,
    profileCode: `${profile.code} v${profile.version}`,
    version: 'test',
    createdBy: actorOf(req),
  })
  compileBuild(build, profile.espModel, [{ path: sketch.filename, content: sketch.content }]).catch((err) => console.error('[build]', err))
  res.status(202).json({ ...buildView(build), espModel: profile.espModel })
})

export default router
