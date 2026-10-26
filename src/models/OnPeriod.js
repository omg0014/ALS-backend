import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// One stretch of time a line (lighting group) was ON, for Analytics. Opened when its relay reports ON,
// closed when it reports OFF or its board goes offline. Room, floor, type and load are copied in, so
// the history stays right after lines are moved or renamed.
const onPeriodSchema = new Schema({
  device: { ...ref('Device'), required: true },
  channel: { type: Number, required: true },
  group: { ...ref('LightingGroup'), required: true },
  room: ref('Room'),
  floor: ref('Floor'),
  type: String,
  amps: { type: Number, default: 0 }, // the line's estimated load, for the energy estimate
  start: { type: Date, required: true },
  end: { type: Date, default: null }, // null = still ON
  backfilled: { type: Boolean, default: false }, // rebuilt from confirmed commands (before this log existed)
})
onPeriodSchema.index({ device: 1, channel: 1, end: 1 })
onPeriodSchema.index({ start: 1, end: 1 })

export const OnPeriod = model('OnPeriod', onPeriodSchema)
