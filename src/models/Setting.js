import mongoose from 'mongoose'

const { Schema, model } = mongoose

// Global settings (key/value), edited on the Settings page.
const settingSchema = new Schema({
  key: { type: String, required: true, unique: true },
  value: Schema.Types.Mixed,
})

export const Setting = model('Setting', settingSchema)
