// Simulated relay device that speaks topic schema v1 exactly like the firmware template.
// Lets you demo and test the platform without hardware.
//
//   npm run simulate -- --id acls-a1b2c3 --secret <MQTT_PASSWORD from config.h> [--host 127.0.0.1] [--port 1883] [--channels 4]
//   External broker (cloud): add --url mqtts://host:8883 --user <MQTT_USER from config.h> [--build <ACLS_BUILD>]
import mqtt from 'mqtt'

// url/user: an external broker (shared device login, TLS with ca); build: ACLS_BUILD from config.h.
export function startSimDevice({ id, secret, host = '127.0.0.1', port = 1883, url, user, ca, build, channels = 4, root = 'acls/v1', fw = '1.1.0', log = () => {}, onOta }) {
  const topic = (leaf) => `${root}/${id}/${leaf}`
  const relays = Array(channels).fill(0) // boot OFF, like the firmware
  const bootAt = Date.now()
  let telemetryTimer = null

  const opts = {
    clientId: id,
    username: user ?? id,
    password: secret,
    ...(ca ? { ca } : {}),
    keepalive: 15,
    reconnectPeriod: 5000,
    clean: true,
    will: { topic: topic('status'), payload: 'offline', qos: 0, retain: true },
  }
  const client = url ? mqtt.connect(url, opts) : mqtt.connect({ host, port, ...opts })

  const publishState = (ack) =>
    client.publish(topic('state'), JSON.stringify(ack ? { ch: relays, ack } : { ch: relays }), { retain: true })
  const publishTelemetry = () =>
    client.publish(
      topic('telemetry'),
      JSON.stringify({ rssi: -58, uptime: Math.floor((Date.now() - bootAt) / 1000), heap: 31000, fw, reset: 'power', ...(build ? { build } : {}) })
    )

  client.on('connect', () => {
    log(`[sim ${id}] connected`)
    client.publish(topic('status'), 'online', { retain: true })
    client.subscribe(topic('cmd'))
    publishState()
    publishTelemetry()
    clearInterval(telemetryTimer)
    telemetryTimer = setInterval(publishTelemetry, 60_000)
  })

  client.on('message', (t, payload) => {
    let msg
    try {
      msg = JSON.parse(payload.toString())
    } catch {
      return
    }
    if (msg.ota) {
      onOta?.(msg) // {"id","ota":"<url>"}: the test decides how to "update"
      return
    }
    if (msg.all === 'ON' || msg.all === 'OFF') relays.fill(msg.all === 'ON' ? 1 : 0)
    else if (msg.ch >= 1 && msg.ch <= channels && (msg.state === 'ON' || msg.state === 'OFF')) relays[msg.ch - 1] = msg.state === 'ON' ? 1 : 0
    else return
    log(`[sim ${id}] cmd ${JSON.stringify(msg)} -> ${JSON.stringify(relays)}`)
    publishState(msg.id)
  })

  client.on('error', (err) => log(`[sim ${id}] error: ${err.message}`))

  return {
    client,
    relays,
    reportOta: (id, result, error) => client.publish(topic('ota'), JSON.stringify({ id, result, error })),
    // Power cut: the TCP connection just dies, so the broker publishes the Last Will.
    powerCut() {
      clearInterval(telemetryTimer)
      client.stream?.destroy()
      client.end(true)
    },
    stop() {
      clearInterval(telemetryTimer)
      return new Promise((r) => client.end(false, r))
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), [])
  )
  if (!args.id || !args.secret) {
    console.error('usage: npm run simulate -- --id acls-a1b2c3 --secret <MQTT_PASSWORD> [--host 127.0.0.1] [--port 1883] [--channels 4]')
    process.exit(1)
  }
  startSimDevice({ ...args, port: Number(args.port ?? 1883), channels: Number(args.channels ?? 4), log: console.log })
}
