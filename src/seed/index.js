// First-run data: hardware profiles P1-P5, the help guides, the first admin account and the pilot
// classroom. Runs on every server start; existing rows are never changed.
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { config } from '../config.js'
import { Floor, Guide, HardwareProfile, LightingGroup, Room, User } from '../models/index.js'
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

export async function seed({ log = console.log } = {}) {
  for (const p of PROFILES) {
    const r = await HardwareProfile.updateOne({ code: p.code, version: 1 }, { $setOnInsert: { ...p, version: 1 } }, { upsert: true })
    if (r.upsertedCount) log(`profile ${p.code} created`)
    // Rows created before moduleKind existed
    await HardwareProfile.updateOne({ code: p.code, version: 1, moduleKind: { $in: [null, 'other'] } }, { $set: { moduleKind: p.moduleKind } })
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
