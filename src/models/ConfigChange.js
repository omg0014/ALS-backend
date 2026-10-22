import mongoose from 'mongoose'
import { actorSchema, ONE_YEAR_S } from './shared.js'

const { Schema, model } = mongoose

// History of every configuration change: who, when, before and after (kept 1 year).
const configChangeSchema = new Schema({
  entity: String,
  entityId: String,
  action: { type: String, enum: ['create', 'update', 'delete'] },
  before: Schema.Types.Mixed,
  after: Schema.Types.Mixed,
  actor: actorSchema,
  time: { type: Date, default: Date.now },
})
configChangeSchema.index({ time: 1 }, { expireAfterSeconds: ONE_YEAR_S })
configChangeSchema.index({ entity: 1, entityId: 1, time: -1 })

export const ConfigChange = model('ConfigChange', configChangeSchema)
