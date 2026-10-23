import { Router } from 'express'
import { config } from '../config.js'
import { Device } from '../models/index.js'
import { ADMIN } from '../lib/auth.js'
import { badRequest } from '../lib/errors.js'
import { logChange } from '../services/changeLog.js'
import { SETTING_DEFS, allSettings, loadSettings, setSetting, trackServerAddress, validateSetting } from '../services/settings.js'
import { brokerFrom, clearMqttConfig, mergeWithSaved, mqttFromEnv, mqttView, saveMqttConfig } from '../services/mqttConfig.js'
import { brokerConnected, restartBroker, testBrokerLogin } from '../services/broker.js'

// Global settings (broker address, stagger, timeouts, alert levels...). Read by all, changed by admins.
const router = Router()

router.get('/settings', (req, res) => {
  // mqtt: where the boards connect: this server's built-in broker, or an external one (cloud)
  res.json({ values: allSettings(), defs: SETTING_DEFS, mqtt: { ...mqttView(), connected: brokerConnected(), cloud: config.cloud } })
})

router.put('/settings', ADMIN, async (req, res) => {
  const updates = req.body ?? {}
  const errors = Object.entries(updates).map(([k, v]) => validateSetting(k, v)).filter(Boolean)
  if (errors.length) throw badRequest('Invalid settings', errors)
  const before = allSettings()
  const notes = []
  let reflash = false
  for (const [k, v] of Object.entries(updates)) {
    if (before[k] === v) continue
    await setSetting(k, v)
    if (SETTING_DEFS[k].reflash) reflash = true
    if (k === 'topicRoot') notes.push('Topic root takes effect after a server restart.')
  }
  if (reflash) {
    // Every board must get a config.h with the new broker / topic settings.
    const at = new Date()
    await Device.updateMany({ status: { $ne: 'retired' } }, { $push: { updateReasons: { reason: 'Broker settings changed', at } } })
    notes.push('All devices are flagged "update needed": regenerate and flash their config.h.')
  }
  await logChange(req, 'settings', 'update', { _id: 'settings', ...before }, { _id: 'settings', ...allSettings() })
  res.json({ values: allSettings(), notes })
})

// ---- External MQTT broker, entered on the Settings page (cloud hosting) ----

function brokerInput(body) {
  const b = mergeWithSaved(body ?? {})
  const errors = []
  if (!/^[a-z0-9.-]+$/i.test(b.host)) errors.push('Broker address: e.g. abc123.s1.eu.hivemq.cloud')
  if (!(b.port > 0 && b.port < 65536)) errors.push('Port: a number such as 8883')
  if (!b.username || !b.password) errors.push('Server login: username and password')
  if (!b.deviceUsername || !b.devicePassword) errors.push('Board login: username and password')
  if (b.deviceCa && !b.deviceCa.includes('-----BEGIN CERTIFICATE-----')) errors.push('Root certificate: paste the whole block from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----')
  if (errors.length) throw badRequest('Please check the broker details', errors)
  return b
}

// Both logins must work before anything is saved
async function testBoth(b) {
  const broker = brokerFrom(b)
  const server = await testBrokerLogin({ url: broker.url, username: b.username, password: b.password })
  if (!server.ok) return { ok: false, error: `Server login failed: ${server.error}` }
  const boards = await testBrokerLogin({ url: broker.url, username: b.deviceUsername, password: b.devicePassword })
  if (!boards.ok) return { ok: false, error: `Board login failed: ${boards.error}` }
  return { ok: true }
}

router.post('/settings/mqtt/test', ADMIN, async (req, res) => {
  res.json(await testBoth(brokerInput(req.body)))
})

router.put('/settings/mqtt', ADMIN, async (req, res) => {
  if (mqttFromEnv()) throw badRequest('The broker is set on the server (MQTT_URL in Render); change it there.')
  const b = brokerInput(req.body)
  const test = await testBoth(b)
  if (!test.ok) throw badRequest(test.error)
  const before = mqttView()
  await saveMqttConfig(b)
  await loadSettings()
  await trackServerAddress() // a new broker address: every board needs new firmware
  await restartBroker()
  await logChange(req, 'settings', 'update', { _id: 'mqttBroker', ...before }, { _id: 'mqttBroker', ...mqttView() })
  res.json({ mqtt: { ...mqttView(), connected: brokerConnected(), cloud: config.cloud } })
})

router.delete('/settings/mqtt', ADMIN, async (req, res) => {
  if (mqttFromEnv()) throw badRequest('The broker is set on the server (MQTT_URL in Render); change it there.')
  const before = mqttView()
  await clearMqttConfig()
  await loadSettings()
  await restartBroker()
  await logChange(req, 'settings', 'update', { _id: 'mqttBroker', ...before }, { _id: 'mqttBroker', ...mqttView() })
  res.json({ mqtt: { ...mqttView(), connected: brokerConnected(), cloud: config.cloud } })
})

export default router
