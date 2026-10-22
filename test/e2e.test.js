// End-to-end check of Phases 1 and 2 against a running server (API + broker) with a simulated device.
//   ADMIN_PASSWORD=... npm test        (use a throwaway database: it creates devices and users)
import assert from 'node:assert/strict'
import net from 'node:net'
import mqtt from 'mqtt'
import mqttPacket from 'mqtt-packet'
import { io } from 'socket.io-client'
import { startSimDevice } from '../src/scripts/simulate-device.js'

const API = process.env.API_URL || 'http://localhost:4000'
const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1'
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chip = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')

let passed = 0
async function step(name, fn) {
  const t = Date.now()
  await fn()
  passed++
  console.log(`  ✓ ${name} (${Date.now() - t} ms)`)
}

function session() {
  let cookie = ''
  const call = async (method, path, body) => {
    const res = await fetch(API + path, {
      method,
      headers: { 'content-type': 'application/json', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const data = await res.json().catch(() => null)
    return { status: res.status, data }
  }
  return { call, cookie: () => cookie }
}

async function waitFor(fn, { timeout = 5000, every = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(every)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function tryConnect(opts) {
  return new Promise((resolve) => {
    const c = mqtt.connect({ host: MQTT_HOST, port: MQTT_PORT, reconnectPeriod: 0, connectTimeout: 3000, ...opts })
    c.once('connect', () => resolve({ ok: true, client: c }))
    c.once('error', (err) => {
      c.end(true)
      resolve({ ok: false, err })
    })
  })
}

async function main() {
  console.log(`ACLS Phase 1+2 e2e against ${API}`)
  const admin = session()
  let room, groups, device, secret, sim, socket
  const events = []

  await step('anonymous API call is rejected', async () => {
    assert.equal((await admin.call('GET', '/api/overview')).status, 401)
  })

  await step('admin logs in', async () => {
    const r = await admin.call('POST', '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.user.role, 'admin')
  })

  const settings = await admin.call('PUT', '/api/settings', { brokerHost: MQTT_HOST, brokerPort: MQTT_PORT })
  assert.equal(settings.status, 200, JSON.stringify(settings.data))

  await step('create floor + room + 4 groups', async () => {
    const floor = (await admin.call('POST', '/api/floors', { name: `Test floor ${chip()}`, order: 99 })).data
    room = (await admin.call('POST', '/api/rooms', { floor: floor._id, standard: '10', section: 'A', roomNumber: '101' })).data
    assert.equal(room.displayName, '10-A · Room 101')
    groups = []
    for (const [name, type, amps] of [['Fans A', 'fans', 3], ['Fans B', 'fans', 2], ['Lights A', 'lights', 1], ['Lights B', 'lights', 7]]) {
      groups.push((await admin.call('POST', '/api/groups', { room: room._id, name, type, estimatedAmps: amps })).data)
    }
  })

  await step('register P1 device with channel mapping; load warning for 7A group', async () => {
    const overview = (await admin.call('GET', '/api/overview')).data
    const p1 = overview.profiles.find((p) => p.code === 'P1')
    const r = await admin.call('POST', '/api/devices', {
      chipId: chip(),
      name: 'Test ESP32',
      room: room._id,
      profile: p1._id,
      channels: groups.map((g, i) => ({ index: i + 1, lightingGroup: g._id })),
    })
    assert.equal(r.status, 201, JSON.stringify(r.data))
    device = r.data.device
    assert.match(device.deviceId, /^acls-[0-9a-f]{6}$/)
    assert.ok(r.data.warnings.some((w) => w.startsWith('IN4') && w.includes('7A')), 'expected load warning on IN4')
  })

  await step('pin rules: forbidden GPIO rejected, allowed GPIO accepted', async () => {
    assert.equal((await admin.call('PUT', `/api/devices/${device._id}/channels/2`, { gpio: 2 })).status, 400)
    assert.equal((await admin.call('PUT', `/api/devices/${device._id}/channels/2`, { gpio: 21 })).status, 400, 'GPIO21 already used by IN3')
    const ok = await admin.call('PUT', `/api/devices/${device._id}/channels/2`, { gpio: 25 })
    assert.equal(ok.status, 200)
    await admin.call('PUT', `/api/devices/${device._id}/channels/2`, { gpio: 22 })
  })

  await step('firmware package: zip with template + config.h (profile pins, trigger, fresh secret)', async () => {
    const r = await admin.call('POST', `/api/devices/${device._id}/firmware`, { wifiSsid: 'School-IoT', wifiPassword: 'p"w\\d' })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const zip = Buffer.from(r.data.zipBase64, 'base64')
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'zip signature')
    for (const f of ['acls_firmware/acls_firmware.ino', 'acls_firmware/config.h', 'README.txt']) assert.ok(zip.includes(Buffer.from(f)), f)
    const c = r.data.files.find((f) => f.path === 'acls_firmware/config.h').content
    assert.match(c, /#define RELAY_PIN_LIST \{23, 22, 21, 19\}/)
    assert.match(c, /#define RELAY_ON LOW/)
    assert.match(c, /#define RELAY_OFF HIGH/)
    assert.match(c, /#define WIFI_PASSWORD "p\\"w\\\\d"/)
    secret = c.match(/#define MQTT_PASSWORD "([^"]+)"/)[1]
    const builds = (await admin.call('GET', `/api/devices/${device._id}/builds`)).data
    assert.equal(builds.length, 1)
    assert.ok(!builds[0].configRedacted.includes(secret), 'secret must not be stored')
    assert.ok(builds[0].configRedacted.includes('MQTT_PASSWORD "<redacted>"'))
    const rooms = (await admin.call('GET', '/api/overview')).data.rooms
    assert.equal(rooms.find((x) => x._id === room._id).wifiSsid, 'School-IoT', 'WiFi name remembered per room')
  })

  await step('broker rejects anonymous and wrong-password devices', async () => {
    assert.equal((await tryConnect({ clientId: device.deviceId })).ok, false)
    assert.equal((await tryConnect({ clientId: device.deviceId, username: device.deviceId, password: 'wrong' })).ok, false)
    assert.equal((await tryConnect({ clientId: 'acls-ffffff', username: device.deviceId, password: secret })).ok, false, 'client id must equal device id')
  })

  await step('ACL: device cannot subscribe to or publish on other topics', async () => {
    const { ok, client } = await tryConnect({ clientId: device.deviceId, username: device.deviceId, password: secret })
    assert.ok(ok)
    // mqtt.js rejects when the broker answers SUBACK 128 (refused)
    const err = await client.subscribeAsync('acls/v1/acls-000000/cmd').then(() => null, (e) => e)
    assert.deepEqual(err?.packet?.granted, [128], 'foreign cmd subscription must be refused')
    const closed = new Promise((r) => client.once('close', r))
    client.publish('acls/v1/acls-000000/state', '{"ch":[1]}')
    await closed // broker drops a client that publishes outside its topics
    client.end(true)
  })

  socket = io(API, { extraHeaders: { cookie: admin.cookie() }, transports: ['websocket'] })
  socket.on('command', (c) => events.push(['command', c]))
  socket.on('device:state', (s) => events.push(['state', s]))
  await waitFor(() => socket.connected, { what: 'socket.io connect' })

  const deviceView = async () => (await admin.call('GET', '/api/overview')).data.devices.find((d) => d._id === device._id)

  await step('simulated device connects: online + update-needed cleared', async () => {
    sim = startSimDevice({ id: device.deviceId, secret, host: MQTT_HOST, port: MQTT_PORT, channels: 4 })
    const d = await waitFor(async () => {
      const v = await deviceView()
      return v.state?.online && v.state?.fw && v
    }, { what: 'device online' })
    assert.equal(d.updateNeeded, false, JSON.stringify(d.updateReasons))
    assert.ok(events.some(([k, s]) => k === 'state' && s.deviceId === device.deviceId && s.online), 'live push to browser')
  })

  const control = (target, state, who = admin) => who.call('POST', '/api/control', { target, state })
  const waitConfirmed = (cmdIds) =>
    waitFor(() => cmdIds.every((id) => events.some(([k, c]) => k === 'command' && c.cmdId === id && c.result === 'confirmed')), {
      what: 'confirmation',
    })

  await step('group ON confirmed by device in under 1 s', async () => {
    const t = Date.now()
    const r = await control({ kind: 'group', id: groups[2]._id }, 'ON')
    assert.equal(r.status, 200, JSON.stringify(r.data))
    assert.equal(r.data.sent, 1)
    await waitConfirmed(r.data.commands.map((c) => c.cmdId))
    const ms = Date.now() - t
    assert.ok(ms < 1000, `took ${ms} ms`)
    assert.deepEqual(sim.relays, [0, 0, 1, 0])
  })

  await step('room ON: 4 channels staggered ~250 ms, all confirmed', async () => {
    const t = Date.now()
    const r = await control({ kind: 'room', id: room._id }, 'ON')
    await waitConfirmed(r.data.commands.map((c) => c.cmdId))
    const ms = Date.now() - t
    assert.ok(ms >= 700, `stagger missing: ${ms} ms`)
    assert.deepEqual(sim.relays, [1, 1, 1, 1])
  })

  await step('floor preview counts groups; floor OFF', async () => {
    const p = await admin.call('POST', '/api/control/preview', { target: { kind: 'floor', id: room.floor }, state: 'OFF' })
    assert.equal(p.data.groupsTotal, 4)
    assert.equal(p.data.groupsChanging, 4)
    const r = await control({ kind: 'floor', id: room.floor }, 'OFF')
    await waitConfirmed(r.data.commands.map((c) => c.cmdId))
    assert.deepEqual(sim.relays, [0, 0, 0, 0])
  })

  await step('unanswered command becomes "not confirmed" after 5 s', async () => {
    sim.client.unsubscribe(`acls/v1/${device.deviceId}/cmd`)
    await sleep(200)
    const r = await control({ kind: 'group', id: groups[0]._id }, 'ON')
    const id = r.data.commands[0].cmdId
    await waitFor(() => events.some(([k, c]) => k === 'command' && c.cmdId === id && c.result === 'not_confirmed'), {
      timeout: 7000,
      what: 'not_confirmed',
    })
    sim.client.subscribe(`acls/v1/${device.deviceId}/cmd`)
    const back = await control({ kind: 'group', id: groups[0]._id }, 'OFF')
    await waitConfirmed(back.data.commands.map((c) => c.cmdId))
  })

  await step('power cut: offline via Last Will, restore last state from DB on power-up', async () => {
    const on = await control({ kind: 'group', id: groups[2]._id }, 'ON')
    await waitConfirmed(on.data.commands.map((c) => c.cmdId))
    sim.powerCut()
    await waitFor(async () => (await deviceView()).state.online === false, { what: 'offline' })
    // While it is off, someone switches Fans A ON: stored as desired state, applied on reconnect.
    const queued = await control({ kind: 'group', id: groups[0]._id }, 'ON')
    assert.equal(queued.data.queuedOffline, 1)
    sim = startSimDevice({ id: device.deviceId, secret, host: MQTT_HOST, port: MQTT_PORT, channels: 4 }) // boots all OFF
    await waitFor(() => sim.relays.join() === '1,0,1,0', { timeout: 5000, what: 'restore [1,0,1,0]' })
    const audit = (await admin.call('GET', `/api/audit/commands?deviceId=${device.deviceId}&limit=5`)).data
    assert.ok(audit.some((c) => c.actor.kind === 'system' && c.target.kind === 'restore'), 'restore is in the audit log')
  })

  const info = (await admin.call('GET', '/api/firmware/info')).data
  if (!info.buildService.ready) {
    console.log('  - skipped website build / OTA checks: toolchain not installed (npm run toolchain:install)')
  } else {
    const waitBuild = (id, until) =>
      waitFor(async () => {
        const b = (await admin.call('GET', `/api/builds/${id}`)).data
        if (b.compile?.status === 'failed') throw new Error(`compile failed:\n${b.compile.log?.slice(-2000)}`)
        return until(b) && b
      }, { timeout: 240000, every: 1000, what: 'build' })

    await step('website build: compile on the server, USB image ready; running board keeps working', async () => {
      const r = await admin.call('POST', `/api/devices/${device._id}/firmware`, { wifiSsid: 'School-IoT', wifiPassword: 'x', compile: true })
      assert.equal(r.status, 200, JSON.stringify(r.data))
      const b = await waitBuild(r.data.buildId, (x) => x.compile?.status === 'ready')
      assert.ok(b.binaryAvailable)
      const res = await fetch(`${API}/api/builds/${r.data.buildId}/usb.bin`, { headers: { cookie: admin.cookie() } })
      const bin = Buffer.from(await res.arrayBuffer())
      assert.equal(res.headers.get('x-flash-offset'), '0')
      assert.equal(bin[0x1000], 0xe9, 'ESP32 bootloader image magic at 0x1000')
      assert.ok(bin.length < 2 * 1024 * 1024, `trimmed merged image (${bin.length} bytes)`)
      // pending credentials: the board still logs in with its current secret
      const again = await tryConnect({ clientId: `${device.deviceId}`, username: device.deviceId, password: secret })
      assert.ok(again.ok, 'current secret still valid until the new firmware logs in')
      again.client.end(true)
      await waitFor(async () => (await deviceView()).state.online, { timeout: 15000, what: 'sim back online (reconnects after 5 s)' })
    })

    await step('OTA blocked for firmware older than 1.1.0', async () => {
      sim.powerCut()
      sim = startSimDevice({ id: device.deviceId, secret, host: MQTT_HOST, port: MQTT_PORT, channels: 4, fw: '1.0.0' })
      await waitFor(async () => (await deviceView()).state?.fw === '1.0.0' && (await deviceView()).state.online, { what: 'fw 1.0.0 online' })
      const r = await admin.call('POST', `/api/devices/${device._id}/ota`, { wifiSsid: 'School-IoT', wifiPassword: 'x' })
      assert.equal(r.status, 400)
      assert.match(r.data.error, /cannot update over WiFi/)
    })

    await step('OTA: compile, board downloads (MD5 ok), restarts with the new firmware', async () => {
      let otaMsg
      const restart = (fw) => startSimDevice({ id: device.deviceId, secret, host: MQTT_HOST, port: MQTT_PORT, channels: 4, fw, onOta: (m) => (otaMsg = m) })
      sim.powerCut()
      sim = restart('1.1.0')
      await waitFor(async () => (await deviceView()).state?.fw === '1.1.0' && (await deviceView()).state.online, { what: 'fw 1.1.0 online' })
      const r = await admin.call('POST', `/api/devices/${device._id}/ota`, { wifiSsid: 'School-IoT', wifiPassword: 'x' })
      assert.equal(r.status, 202, JSON.stringify(r.data))
      await waitFor(() => otaMsg, { timeout: 240000, every: 500, what: 'ota command' })
      const res = await fetch(otaMsg.ota)
      assert.equal(res.status, 200)
      const body = Buffer.from(await res.arrayBuffer())
      const { createHash } = await import('node:crypto')
      assert.equal(res.headers.get('x-md5'), createHash('md5').update(body).digest('hex'))
      assert.equal(body[0], 0xe9, 'ESP32 app image')
      sim.reportOta(otaMsg.id, 'started')
      await waitBuild(r.data._id, (b) => b.ota.status === 'started')
      // The new secret is inside the compiled image: find it and "reboot" with it, like the real board.
      const candidates = [...body.toString('latin1').matchAll(/(?<=\0)[A-Za-z0-9_-]{32}(?=\0)/g)].map((m) => m[0])
      sim.powerCut()
      let found = null
      for (const c of candidates) {
        const t = await tryConnect({ clientId: device.deviceId, username: device.deviceId, password: c })
        if (t.ok) {
          found = c
          t.client.end(true)
          break
        }
      }
      assert.ok(found, `new secret not found in image (${candidates.length} candidates)`)
      const done = await waitBuild(r.data._id, (b) => b.ota.status === 'done')
      assert.ok(done.installedAt)
      assert.equal((await fetch(otaMsg.ota)).status, 404, 'OTA link is single-use')
      assert.equal((await tryConnect({ clientId: device.deviceId, username: device.deviceId, password: secret })).ok, false, 'old secret retired')
      secret = found
      sim = restart('1.1.0')
      await waitFor(async () => (await deviceView()).state.online, { what: 'online after OTA' })
      assert.equal((await deviceView()).updateNeeded, false)
    })

    await step('website build: NodeMCU test sketch compiles for USB upload', async () => {
      const p2 = (await admin.call('GET', '/api/profiles')).data.find((p) => p.code === 'P2')
      const r = await admin.call('POST', `/api/profiles/${p2._id}/test-sketches/pin_test/build`, {})
      assert.equal(r.status, 202, JSON.stringify(r.data))
      await waitBuild(r.data._id, (b) => b.compile?.status === 'ready')
      const bin = Buffer.from(await (await fetch(`${API}/api/builds/${r.data._id}/usb.bin`, { headers: { cookie: admin.cookie() } })).arrayBuffer())
      assert.equal(bin[0], 0xe9, 'ESP8266 image magic')
    })
  }

  await step('roles: viewer cannot switch; staff can switch a room but not a floor', async () => {
    const mk = async (role) => {
      const username = `${role}${chip()}`
      assert.equal((await admin.call('POST', '/api/users', { name: role, username, password: 'password123', role })).status, 201)
      const s = session()
      await s.call('POST', '/api/auth/login', { username, password: 'password123' })
      return s
    }
    const viewer = await mk('viewer')
    const staff = await mk('staff')
    assert.equal((await control({ kind: 'room', id: room._id }, 'OFF', viewer)).status, 403)
    assert.equal((await control({ kind: 'floor', id: room.floor }, 'OFF', staff)).status, 403)
    const r = await control({ kind: 'room', id: room._id }, 'OFF', staff)
    assert.equal(r.status, 200)
    await waitConfirmed(r.data.commands.map((c) => c.cmdId))
    const audit = (await admin.call('GET', `/api/audit/commands?deviceId=${device.deviceId}&limit=4`)).data
    assert.ok(audit.every((c) => c.actor.name === 'staff' && c.result === 'confirmed'))
  })

  await step('silent device (no packets, socket open) shown offline within 30 s', async () => {
    await sim.stop()
    await waitFor(async () => (await deviceView()).state.online === false, { what: 'clean offline' })
    // Raw CONNECT with keepalive 15 and then silence, like a board that hung.
    const sock = net.connect(MQTT_PORT, MQTT_HOST)
    await new Promise((r) => sock.once('connect', r))
    sock.write(
      mqttPacket.generate({
        cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: true, keepalive: 15,
        clientId: device.deviceId, username: device.deviceId, password: Buffer.from(secret),
        will: { topic: `acls/v1/${device.deviceId}/status`, payload: Buffer.from('offline'), retain: true, qos: 0 },
      })
    )
    sock.write(mqttPacket.generate({ cmd: 'publish', topic: `acls/v1/${device.deviceId}/status`, payload: 'online', retain: true, qos: 0 }))
    await waitFor(async () => (await deviceView()).state.online, { what: 'raw online' })
    const t = Date.now()
    await waitFor(async () => (await deviceView()).state.online === false, { timeout: 30000, every: 500, what: 'keepalive offline' })
    sock.destroy()
    console.log(`    (offline detected ${((Date.now() - t) / 1000).toFixed(1)} s after the last packet)`)
  })

  await step('Phase 2: wiring plan, test sketches, chip-id sketch', async () => {
    const w = (await admin.call('GET', `/api/devices/${device._id}/wiring`)).data
    assert.equal(w.plan.signal[0].from, 'ESP32 D23 (GPIO23)')
    assert.equal(w.plan.signal[0].to, 'Relay IN1')
    assert.ok(w.plan.jumpers.some((j) => j.includes('JD-VCC')))
    assert.ok(w.plan.outputs[0].no.includes('Fans A'))
    const t = (await admin.call('POST', `/api/profiles/${device.profile._id}/test-sketches`, { wifiSsid: 'X', wifiPassword: 'Y' })).data
    assert.deepEqual(t.sketches.map((x) => x.kind), ['pin_test', 'led_chaser', 'wifi_test'])
    assert.ok(t.sketches[0].content.includes('{23, 22, 21, 19}') && t.sketches[0].content.includes('#define RELAY_ON LOW'))
    assert.ok(t.sketches.every((x) => x.whatToSee.length >= 3))
    assert.ok((await admin.call('GET', '/api/firmware/chip-id-sketch')).data.content.includes('ACLS device ID'))
  })

  await step('Phase 2: drafts never keep the WiFi password', async () => {
    const d = (await admin.call('PUT', '/api/drafts/firmware:test', { step: 5, data: { wifiSsid: 'A', wifiPassword: 'secret' } })).data
    assert.equal(d.data.wifiPassword, undefined)
    assert.equal((await admin.call('GET', '/api/drafts/firmware:test')).data.step, 5)
    await admin.call('DELETE', '/api/drafts/firmware:test')
  })

  await step('Phase 2: new profile only with allowed pins, saved UNVERIFIED', async () => {
    const base = { code: `T${chip()}`, espModel: 'esp8266', espBoard: 'NodeMCU', relayModule: 'test', channels: 2, trigger: 'LOW' }
    const bad = await admin.call('POST', '/api/profiles', { ...base, pins: [{ gpio: 0 }, { gpio: 5 }] })
    assert.equal(bad.status, 400, 'GPIO0 (D3) must be refused')
    const ok = await admin.call('POST', '/api/profiles', { ...base, pins: [{ gpio: 5 }, { gpio: 13 }] })
    assert.equal(ok.status, 201, JSON.stringify(ok.data))
    assert.equal(ok.data.verified, false)
    assert.deepEqual(ok.data.pins.map((p) => p.label), ['D1', 'D7'])
  })

  await step('Phase 2: installation flow (bench test, commissioning, Live gate)', async () => {
    const st0 = (await admin.call('GET', `/api/rooms/${room._id}/install`)).data
    assert.equal(st0.steps.length, 8)
    const checklist = st0.devices[0].checklist
    await admin.call('POST', `/api/devices/${device._id}/bench-test`, { checks: checklist.map((label) => ({ key: label, label, ok: true })) })
    let st = (await admin.call('GET', `/api/rooms/${room._id}/install`)).data
    assert.equal(st.room.stage, 'bench_tested')
    assert.ok(st.steps.find((x) => x.key === 'bench').done)
    assert.equal((await admin.call('PUT', `/api/rooms/${room._id}/stage`, { stage: 'live' })).status, 400, 'Live needs commissioning')
    for (const g of groups) await admin.call('POST', `/api/rooms/${room._id}/commissioning`, { lightingGroup: g._id, result: 'pass' })
    const live = await admin.call('PUT', `/api/rooms/${room._id}/stage`, { stage: 'live' })
    assert.equal(live.status, 200, JSON.stringify(live.data))
    assert.equal(live.data.room.stage, 'live')
  })

  await step('Phase 2: guides seeded; only admin edits', async () => {
    const list = (await admin.call('GET', '/api/guides')).data
    assert.ok(list.some((g) => g.slug === 'relay-never-releases'))
    const viewer = session()
    const username = `v${chip()}`
    await admin.call('POST', '/api/users', { name: 'v', username, password: 'password123', role: 'viewer' })
    await viewer.call('POST', '/api/auth/login', { username, password: 'password123' })
    assert.equal((await viewer.call('PUT', '/api/guides/port-not-found', { title: 'x' })).status, 403)
  })

  await step('Phase 2: replace board keeps room, channels and history', async () => {
    const before = (await admin.call('GET', `/api/devices/${device._id}`)).data
    const newChip = chip()
    const r = await admin.call('POST', `/api/devices/${device._id}/replace`, { chipId: newChip })
    assert.equal(r.status, 200, JSON.stringify(r.data))
    const after = (await admin.call('GET', `/api/devices/${device._id}`)).data
    assert.equal(after.device.deviceId, `acls-${newChip}`)
    assert.deepEqual(after.device.previousIds, [before.device.deviceId])
    assert.equal(String(after.device.room._id), String(before.device.room._id))
    assert.deepEqual(after.channels.map((c) => c.lightingGroup?._id), before.channels.map((c) => c.lightingGroup?._id))
    assert.ok(after.commands.length > 0, 'command history kept')
    // the old board's credentials no longer work
    assert.equal((await tryConnect({ clientId: before.device.deviceId, username: before.device.deviceId, password: secret })).ok, false)
    // new firmware for the new board, and it can connect
    const fw = (await admin.call('POST', `/api/devices/${device._id}/firmware`, { wifiSsid: 'School-IoT', wifiPassword: 'x' })).data
    secret = fw.files.find((f) => f.path.endsWith('config.h')).content.match(/MQTT_PASSWORD "([^"]+)"/)[1]
    device.deviceId = `acls-${newChip}`
    const c = await tryConnect({ clientId: device.deviceId, username: device.deviceId, password: secret })
    assert.ok(c.ok, 'new board connects')
    c.client.end(true)
  })

  await step('retired device can no longer connect', async () => {
    assert.equal((await admin.call('POST', `/api/devices/${device._id}/retire`)).status, 200)
    assert.equal((await tryConnect({ clientId: device.deviceId, username: device.deviceId, password: secret })).ok, false)
  })

  socket.close()
  console.log(`\nAll ${passed} checks passed.`)
  process.exit(0)
}

main().catch((err) => {
  console.error('\nFAILED:', err)
  process.exit(1)
})
