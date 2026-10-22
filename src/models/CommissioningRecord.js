import mongoose from 'mongoose'
import { ref, actorSchema } from './shared.js'

const { Schema, model } = mongoose

// Result of switching one lighting group from the website after installation.
const commissioningSchema = new Schema({
  room: { ...ref('Room'), required: true },
  device: ref('Device'),
  channel: Number,
  lightingGroup: ref('LightingGroup'),
  groupName: String,
  result: { type: String, enum: ['pass', 'fail'] },
  notes: String,
  installer: actorSchema,
  at: { type: Date, default: Date.now },
})
commissioningSchema.index({ room: 1, at: -1 })

export const CommissioningRecord = model('CommissioningRecord', commissioningSchema)
