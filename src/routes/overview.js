import { Router } from 'express'
import { Channel, Device, DeviceState, Floor, HardwareProfile, LightingGroup, Room } from '../models/index.js'
import { getSetting } from '../services/settings.js'
import { templateVersion } from '../lib/firmware/index.js'
import { stateView } from '../services/deviceEvents.js'

const router = Router()

// Everything the Control and Devices views need in one call (300 devices / 1,200 channels is small).
router.get('/overview', async (req, res) => {
  const [floors, rooms, groups, profiles, devices, channels, states] = await Promise.all([
    Floor.find().sort({ order: 1, name: 1 }).lean(),
    Room.find().sort({ displayName: 1 }).lean(),
    LightingGroup.find().sort({ name: 1 }).lean(),
    HardwareProfile.find().lean(),
    Device.find(req.query.includeRetired ? {} : { status: { $ne: 'retired' } }).sort({ name: 1 }).lean(),
    Channel.find().sort({ index: 1 }).lean(),
    DeviceState.find().lean(),
  ])
  const channelsByDevice = Map.groupBy(channels, (c) => String(c.device))
  const stateByDevice = new Map(states.map((s) => [String(s.device), s]))
  res.json({
    floors,
    rooms,
    groups,
    profiles: profiles.map(({ _id, code, version, espModel, espBoard, relayModule, channels: n, trigger, verified, statusNote, maxAmpsPerChannel, contactRatingA }) => ({
      _id, code, version, espModel, espBoard, relayModule, channels: n, trigger, verified, statusNote, maxAmpsPerChannel, contactRatingA,
    })),
    devices: devices.map((d) => ({
      _id: d._id,
      deviceId: d.deviceId,
      name: d.name,
      room: d.room,
      profile: d.profile,
      kind: d.kind ?? 'acls',
      simple: d.kind === 'simple' ? { url: d.simple?.url, username: d.simple?.username, commandTopic: d.simple?.commandTopic, stateTopic: d.simple?.stateTopic, onPayload: d.simple?.onPayload, offPayload: d.simple?.offPayload, retain: d.simple?.retain } : undefined,
      status: d.status,
      firmwareVersion: d.firmwareVersion,
      mac: d.mac,
      installedOn: d.installedOn,
      updateReasons: d.updateReasons ?? [],
      updateNeeded: (d.updateReasons?.length ?? 0) > 0,
      channels: (channelsByDevice.get(String(d._id)) ?? []).map(({ _id, index, gpio, lightingGroup, desiredState }) => ({
        _id, index, gpio, lightingGroup, desiredState,
      })),
      state: stateView(stateByDevice.get(String(d._id))) ?? null,
    })),
    settings: {
      firmwareVersion: templateVersion(),
      rssiAlertDbm: getSetting('rssiAlertDbm'),
      powerLossBehaviour: getSetting('powerLossBehaviour'),
    },
  })
})

// Dashboard alerts (F3.5): offline too long, repeated reboots, weak WiFi.
router.get('/alerts', async (req, res) => {
  const [devices, states] = await Promise.all([
    Device.find({ status: 'active' }).populate('room').lean(),
    DeviceState.find().lean(),
  ])
  const stateByDevice = new Map(states.map((s) => [String(s.device), s]))
  const now = Date.now()
  const offlineMs = getSetting('offlineAlertMinutes') * 60_000
  const rssiMin = getSetting('rssiAlertDbm')
  const bootWindow = getSetting('rebootAlertWindowMinutes') * 60_000
  const bootCount = getSetting('rebootAlertCount')
  const alerts = []
  for (const d of devices) {
    const s = stateByDevice.get(String(d._id))
    const where = d.room?.displayName ?? 'no room'
    const base = { device: d._id, deviceId: d.deviceId, name: d.name, room: where }
    if (!s?.lastSeen) {
      alerts.push({ ...base, kind: 'never_seen', severity: 'info', message: `${d.name} (${where}) has never connected` })
      continue
    }
    if (!s.online && now - new Date(s.lastSeen) > offlineMs) {
      alerts.push({ ...base, kind: 'offline', severity: 'high', since: s.lastSeen, message: `${d.name} (${where}) offline since ${new Date(s.lastSeen).toLocaleString()}` })
    }
    const boots = (s.recentBoots ?? []).filter((t) => now - new Date(t) < bootWindow).length
    if (boots >= bootCount) {
      alerts.push({ ...base, kind: 'reboots', severity: 'high', message: `${d.name} (${where}) rebooted ${boots}× recently (last reason: ${s.rebootReason ?? '?'}). Check the 5V supply.` })
    }
    if (s.online && typeof s.rssi === 'number' && s.rssi < rssiMin) {
      alerts.push({ ...base, kind: 'weak_wifi', severity: 'medium', message: `${d.name} (${where}) weak WiFi: ${s.rssi} dBm` })
    }
  }
  res.json(alerts)
})

export default router
