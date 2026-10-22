import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// A classroom or other room (office, reception, staff room).
const roomSchema = new Schema(
  {
    floor: { ...ref('Floor'), required: true },
    type: { type: String, enum: ['classroom', 'office', 'reception', 'staffroom', 'other'], default: 'classroom' },
    standard: { type: String, trim: true, default: '' },
    section: { type: String, trim: true, default: '' },
    roomNumber: { type: String, trim: true, default: '' },
    displayName: { type: String, required: true, trim: true },
    stage: { type: String, enum: ['draft', 'bench_tested', 'installed', 'live'], default: 'draft' },
    // WiFi differs per floor/classroom; the name is remembered for the firmware wizard, the password never is.
    wifiSsid: { type: String, default: '' },
  },
  { timestamps: true }
)
roomSchema.index({ floor: 1 })

export const Room = model('Room', roomSchema)
