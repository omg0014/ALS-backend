import mongoose from 'mongoose'
import { ref, actorSchema, ONE_YEAR_S } from './shared.js'

const { Schema, model } = mongoose

// Audit log of every ON/OFF command and whether the device confirmed it (kept 1 year).
const commandSchema = new Schema({
  cmdId: { type: String, required: true, unique: true },
  batchId: { type: String, index: true },
  actor: actorSchema,
  sourceIp: String,
  target: { _id: false, kind: { type: String, enum: ['group', 'room', 'floor', 'all', 'restore'] }, id: String, label: String },
  device: ref('Device'),
  deviceId: String,
  channel: Number,
  lightingGroup: ref('LightingGroup'),
  desired: { type: String, enum: ['ON', 'OFF'] },
  createdAt: { type: Date, default: Date.now },
  sentAt: Date,
  confirmedAt: Date,
  latencyMs: Number,
  result: {
    type: String,
    enum: ['pending', 'confirmed', 'not_confirmed', 'failed', 'queued_offline', 'superseded'],
    default: 'pending',
  },
})
commandSchema.index({ createdAt: 1 }, { expireAfterSeconds: ONE_YEAR_S })
commandSchema.index({ deviceId: 1, createdAt: -1 })

export const Command = model('Command', commandSchema)
