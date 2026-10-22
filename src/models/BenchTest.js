import mongoose from 'mongoose'
import { ref, actorSchema } from './shared.js'

const { Schema, model } = mongoose

// Result of the bench checklist for a device before installation.
const checkSchema = new Schema({ key: String, label: String, ok: Boolean }, { _id: false })

// Bench test on the desk before installation (C2 step 4).
const benchTestSchema = new Schema({
  device: { ...ref('Device'), required: true },
  room: ref('Room'),
  profile: ref('HardwareProfile'),
  checks: [checkSchema],
  passed: Boolean,
  notes: String,
  by: actorSchema,
  at: { type: Date, default: Date.now },
})

// Commissioning test from the website after installation (C2 step 7).

export const BenchTest = model('BenchTest', benchTestSchema)
