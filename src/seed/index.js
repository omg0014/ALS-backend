// First-run data: hardware profiles P1-P5, the help guides, the first admin account and the pilot
// classroom. Runs on every server start; existing rows are never changed.
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { config } from '../config.js'
import { DeviceTemplate, Floor, Guide, HardwareProfile, LightingGroup, Room, User } from '../models/index.js'
import { GUIDES } from './guides.js'
import { PROFILES } from './profiles.js'
import { hashPassword } from '../lib/crypto.js'

// Pilot classroom switchboard (PRD "Electrical wiring model" example).
const PILOT_GROUPS = [
  { name: 'Fans A', type: 'fans', switches: 'Fan 1-3 (K1 / IN1, wired)' },
  { name: 'Fans B', type: 'fans', switches: 'Fan 4-5 + plain switch (K2 / IN2, not wired)' },
  { name: 'Lights A', type: 'lights', switches: 'Light 1-3 (K3 / IN3, wired)' },
  { name: 'Lights B', type: 'lights', switches: 'Light 4-6 (K4 / IN4, not wired)' },
]

const TEMPLATES = [
  { name: 'ESP-12E + 30 A 1-ch · 1 AC', code: 'P2', counts: { ac: 1 } },
  { name: 'ESP-12E + 30 A 1-ch · 1 TV / smart board', code: 'P2', counts: { load: 1 } },
  { name: 'ESP-12E + 10 A 4-ch · 2 lights, 2 fans', code: 'P4', counts: { lights: 2, fans: 2 } },
  { name: 'ESP32 + 10 A 4-ch · 2 lights, 2 fans', code: 'P1', counts: { lights: 2, fans: 2 } },
]

export async function seed({ log = console.log } = {}) {
  for (const p of PROFILES) {
    const r = await HardwareProfile.updateOne({ code: p.code, version: 1 }, { $setOnInsert: { ...p, version: 1 } }, { upsert: true })
    if (r.upsertedCount) log(`profile ${p.code} created`)
    // Rows created before moduleKind existed
    await HardwareProfile.updateOne({ code: p.code, version: 1, moduleKind: { $in: [null, 'other'] } }, { $set: { moduleKind: p.moduleKind } })
  }

  // Stand-in hardware type for boards that run their own code (simple MQTT boards)
  await HardwareProfile.updateOne(
    { code: 'MQTT', version: 1 },
    {
      $setOnInsert: {
        code: 'MQTT',
        version: 1,
        espModel: 'esp8266',
        espBoard: 'Any board running its own code',
        relayModule: 'Its own relay wiring',
        moduleKind: 'other',
        channels: 1,
        trigger: 'HIGH',
        pins: [{ label: 'own code', gpio: 0 }],
        setupNotes: ['Runs its own code. The website publishes the ON/OFF message to its MQTT topic.'],
        verified: true,
        statusNote: 'Own code (MQTT topic)',
        simple: true,
      },
    },
    { upsert: true }
  )

  // Ready-made device templates (owner request 2026-10-23): the common classroom boxes
  for (const t of TEMPLATES) {
    const profile = await HardwareProfile.findOne({ code: t.code, version: 1 }).lean()
    if (!profile) continue
    const r = await DeviceTemplate.updateOne(
      { name: t.name },
      { $setOnInsert: { name: t.name, espModel: profile.espModel, profile: profile._id, counts: t.counts, builtIn: true } },
      { upsert: true }
    )
    if (r.upsertedCount) log(`template "${t.name}" created`)
  }

  for (const g of GUIDES) {
    const r = await Guide.updateOne({ slug: g.slug }, { $setOnInsert: { ...g, updatedBy: { kind: 'system', name: 'seed' } } }, { upsert: true })
    if (r.upsertedCount) {
      log(`guide "${g.slug}" created`)
      continue
    }
    // Refresh guides nobody has edited on the website; an admin's edits are never overwritten.
    const u = await Guide.updateOne(
      { slug: g.slug, 'updatedBy.kind': 'system', $or: [{ markdown: { $ne: g.markdown } }, { title: { $ne: g.title } }, { order: { $ne: g.order } }] },
      { $set: { title: g.title, category: g.category, order: g.order, markdown: g.markdown } }
    )
    if (u.modifiedCount) log(`guide "${g.slug}" updated`)
  }

  if (!(await User.exists({}))) {
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url')
    await User.create({ name: 'Administrator', username: 'admin', role: 'admin', passwordHash: await hashPassword(password) })
    log(`admin user created: username "admin", password "${password}" (change it after first login)`)
  }

  if (!(await Floor.exists({}))) {
    const floor = await Floor.create({ name: 'Pilot floor', order: 0 })
    const room = await Room.create({ floor: floor._id, type: 'classroom', displayName: 'Pilot classroom', stage: 'installed' })
    await LightingGroup.insertMany(PILOT_GROUPS.map((g) => ({ ...g, room: room._id })))
    log('pilot floor, classroom and 4 lighting groups created (rename them in the UI)')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await mongoose.connect(config.mongoUrl)
  await seed()
  await mongoose.disconnect()
}
