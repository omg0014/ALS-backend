import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// A set of switches (lights, fans, mixed, an AC, or a TV/smart-board "load") fed by one relay channel.
const lightingGroupSchema = new Schema(
  {
    room: { ...ref('Room'), required: true },
    name: { type: String, required: true, trim: true },
    // "ac", "load" (TV / smart-board points) and "all" (lights + fans + TV: a whole classroom on one
    // relay) belong on 30A relays
    type: { type: String, enum: ['lights', 'fans', 'mixed', 'ac', 'load', 'all'], default: 'lights' },
    switches: { type: String, default: '' },
    estimatedAmps: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
)
lightingGroupSchema.index({ room: 1 })

export const LightingGroup = model('LightingGroup', lightingGroupSchema)
