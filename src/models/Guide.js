import mongoose from 'mongoose'
import { actorSchema } from './shared.js'

const { Schema, model } = mongoose

// Editable Markdown guides (admins correct them without a developer).
const guideSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, match: /^[a-z0-9-]+$/ },
    title: { type: String, required: true },
    category: { type: String, enum: ['setup', 'upload', 'troubleshooting', 'other'], default: 'other' },
    order: { type: Number, default: 0 },
    markdown: { type: String, default: '' },
    updatedBy: actorSchema,
  },
  { timestamps: true }
)

export const Guide = model('Guide', guideSchema)
