import mongoose from 'mongoose'

const { Schema, model } = mongoose

// A floor of the school building.
const floorSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
)

export const Floor = model('Floor', floorSchema)
