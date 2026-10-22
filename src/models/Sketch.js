import mongoose from 'mongoose'
import { actorSchema } from './shared.js'

const { Schema, model } = mongoose

// A program written in the website's code editor (not the ACLS firmware, which is always generated).
const sketchSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    board: { type: String, enum: ['esp32', 'esp8266'], default: 'esp8266' },
    code: { type: String, default: '', maxlength: 200000 },
    updatedBy: actorSchema,
  },
  { timestamps: true }
)

export const Sketch = model('Sketch', sketchSchema)
