import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// A set of switches (lights, fans, mixed or a TV/smart-board "load") fed by one relay channel.
const lightingGroupSchema = new Schema(
  {
    room: { ...ref('Room'), required: true },
    name: { type: String, required: true, trim: true },
    // "load" = TV / smart-board points on 30A relays (generic group in this build)
    type: { type: String, enum: ['lights', 'fans', 'mixed', 'load'], default: 'lights' },
    switches: { type: String, default: '' },
    estimatedAmps: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
)
lightingGroupSchema.index({ room: 1 })

export const LightingGroup = model('LightingGroup', lightingGroupSchema)
