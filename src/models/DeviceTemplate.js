import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

const LINE_TYPES = ['lights', 'fans', 'mixed', 'ac', 'load', 'all']

// A reusable "Add a device" starting point: ESP board + relay board + how many mains lines of each
// kind, e.g. "ESP-12E + 30 A 1-ch · 1 AC". Picked in the wizard instead of answering again.
const deviceTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    espModel: { type: String, enum: ['esp32', 'esp8266'], required: true },
    profile: { ...ref('HardwareProfile'), required: true },
    counts: Object.fromEntries(LINE_TYPES.map((t) => [t, { type: Number, default: 0, min: 0, max: 16 }])),
    builtIn: { type: Boolean, default: false },
  },
  { timestamps: true }
)

export const DeviceTemplate = model('DeviceTemplate', deviceTemplateSchema)
