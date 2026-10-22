import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// Live state reported by a device: online, confirmed relay states, health.
const deviceStateSchema = new Schema({
  device: { ...ref('Device'), required: true, unique: true },
  deviceId: { type: String, required: true, unique: true },
  online: { type: Boolean, default: false },
  lastSeen: { type: Date, default: null },
  onlineSince: { type: Date, default: null },
  rssi: Number,
  uptime: Number,
  heap: Number,
  fw: String,
  rebootReason: String,
  channelStates: { type: [Number], default: [] }, // confirmed by the device
  recentBoots: { type: [Date], default: [] },
  needsReconcile: { type: Boolean, default: false },
})

export const DeviceState = model('DeviceState', deviceStateSchema)
