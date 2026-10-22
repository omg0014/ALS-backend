import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// Wizard progress, saved after each step so it can be resumed.
const draftSchema = new Schema(
  {
    user: { ...ref('User'), required: true },
    key: { type: String, required: true }, // e.g. "firmware:new" or "firmware:<deviceId>"
    step: { type: Number, default: 0 },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
)
draftSchema.index({ user: 1, key: 1 }, { unique: true })

export const Draft = model('Draft', draftSchema)
