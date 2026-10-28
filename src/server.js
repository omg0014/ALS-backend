import http from 'node:http'
import mongoose from 'mongoose'
import { config } from './config.js'
import { createApp } from './app.js'
import { seed } from './seed/index.js'
import { allSettings, loadSettings, trackServerAddress } from './services/settings.js'
import { loadMqttConfig, externalMqtt } from './services/mqttConfig.js'
import { startBroker, stopBroker } from './services/broker.js'
import { initRealtime } from './services/realtime.js'
import { onDeviceDisconnect, onDeviceMessage, resetLiveState } from './services/deviceEvents.js'
import { closeStaleCommands, handleAck, reconcileDevice } from './services/commands.js'
import { backfillFromCommands, closeStalePeriods } from './services/analytics.js'
import { startSimpleBoards, stopSimpleBoards } from './services/simpleBoards.js'
import { cleanupOldBuilds } from './services/firmware/builder.js'
import { closeStaleBuilds } from './services/firmware/jobs.js'
import { startScheduler, stopScheduler } from './services/scheduler.js'

// Starts everything in one process: database, website + API, live updates and MQTT (the built-in
// broker, or a connection to an external one such as HiveMQ Cloud when MQTT_URL is set).
// A background task that fails (e.g. during a short database outage) is logged, never allowed to stop
// the server: lights must stay controllable. MongoDB reconnects by itself.
process.on('unhandledRejection', (err) => console.error('[error] background task failed:', err?.message ?? err))

async function main() {
  mongoose.connection.on('error', (err) => console.error('[db] error:', err.message))
  mongoose.connection.on('disconnected', () => console.warn('[db] connection lost, reconnecting…'))
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected'))
  await mongoose.connect(config.mongoUrl)
  console.log(`[db] connected ${config.mongoUrl.replace(/\/\/.*@/, '//***@')}`)
  await Promise.all(mongoose.modelNames().map((n) => mongoose.model(n).syncIndexes()))
  await seed({ log: (m) => console.log(`[seed] ${m}`) })
  await loadMqttConfig()
  await loadSettings()
  await trackServerAddress()
  await resetLiveState()
  await closeStalePeriods()
  await backfillFromCommands()
  await closeStaleCommands()
  await closeStaleBuilds()

  cleanupOldBuilds()
  setInterval(cleanupOldBuilds, 3600 * 1000).unref()

  const server = http.createServer(createApp())
  initRealtime(server)
  await startBroker({ port: config.mqttPort, onMessage: onDeviceMessage, onDisconnect: onDeviceDisconnect })
  await startSimpleBoards({ handleAck, reconcileDevice })
  startScheduler()
  await new Promise((resolve) => server.listen(config.port, resolve))
  console.log(`[api] listening on :${config.port}  →  open ${config.publicUrl || `http://localhost:${config.port}`}`)
  if (externalMqtt()) console.log(`[api] devices connect to the MQTT broker ${externalMqtt().host}:${externalMqtt().port}`)
  else if (config.cloud) console.warn('[api] no MQTT broker yet: an admin enters it on the Settings page')
  else if (allSettings().brokerHost) console.log(`[api] devices connect to ${allSettings().brokerHost}:${config.mqttPort}; others on the network open http://${allSettings().brokerHost}:${config.port}`)

  const shutdown = async () => {
    console.log('shutting down')
    server.close()
    stopScheduler()
    await stopBroker()
    await stopSimpleBoards()
    await mongoose.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
