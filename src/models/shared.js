import mongoose from 'mongoose'

const { Schema } = mongoose

export const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name })
export const ONE_YEAR_S = 365 * 24 * 3600 // audit retention (PRD)

// Who did something: a logged-in user, a schedule, or the system (e.g. restore after a power cut).
export const actorSchema = new Schema(
  { kind: { type: String, enum: ['user', 'schedule', 'system'] }, user: ref('User'), name: String },
  { _id: false }
)
