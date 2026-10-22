import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// A website login: admin, facility staff or viewer.
const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ['admin', 'staff', 'viewer'], default: 'viewer' },
    allowedFloors: [ref('Floor')], // empty = all floors
    active: { type: Boolean, default: true },
    lastLoginAt: Date,
  },
  { timestamps: true }
)

export const User = model('User', userSchema)
