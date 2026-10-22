import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// One relay output of a device and the lighting group it feeds.
const channelSchema = new Schema(
  {
    device: { ...ref('Device'), required: true },
    index: { type: Number, required: true, min: 1 },
    gpio: { type: Number, required: true },
    lightingGroup: { ...ref('LightingGroup'), default: null }, // null = spare
    // Last state asked for (0/1). Kept through power cuts and restored on reconnect.
    desiredState: { type: Number, enum: [0, 1], default: 0 },
  },
  { timestamps: true }
)
channelSchema.index({ device: 1, index: 1 }, { unique: true })
channelSchema.index({ lightingGroup: 1 })

export const Channel = model('Channel', channelSchema)
