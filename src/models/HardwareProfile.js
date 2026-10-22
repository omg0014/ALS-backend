import mongoose from 'mongoose'

const { Schema, model } = mongoose

// A tested ESP board + relay module combination (P1-P5). New modules are new rows, not code.
const hardwareProfileSchema = new Schema(
  {
    code: { type: String, required: true }, // P1..P5
    version: { type: Number, default: 1 },
    espModel: { type: String, enum: ['esp32', 'esp8266'], required: true },
    espBoard: { type: String, required: true },
    relayModule: { type: String, required: true },
    // Drives the generated wiring table: blue4 = Blue 4-ch SRD-05VDC, blue2 = Blue 2-ch JQC-3FC, red30 = Red 1-ch 30A SLA-05VDC
    moduleKind: { type: String, enum: ['blue4', 'blue2', 'red30', 'other'], default: 'other' },
    channels: { type: Number, required: true, min: 1 },
    trigger: { type: String, enum: ['HIGH', 'LOW'], required: true },
    triggerNote: { type: String, default: '' },
    pins: [{ _id: false, label: String, gpio: Number }],
    contactRatingA: { type: Number },
    maxAmpsPerChannel: { type: Number, default: null },
    statusLed: { _id: false, gpio: { type: Number, default: null }, activeLow: { type: Boolean, default: true } },
    setupNotes: { type: [String], default: [] },
    verified: { type: Boolean, default: false },
    statusNote: { type: String, default: '' },
  },
  { timestamps: true }
)
hardwareProfileSchema.index({ code: 1, version: 1 }, { unique: true })

export const HardwareProfile = model('HardwareProfile', hardwareProfileSchema)
