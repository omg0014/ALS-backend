import mongoose from 'mongoose'
import { actorSchema } from './shared.js'

const { Schema, model } = mongoose

// A timetable for one target (a line, a classroom, a floor or the whole school): on the chosen days,
// each slot turns it ON at `start` and OFF again at `end` (time range) or after `minutes` (timer).
// Times are wall-clock times in the school's time zone. Switching by hand always works: the schedule
// only acts again at its next ON or OFF time.
const slotSchema = new Schema(
  {
    kind: { type: String, enum: ['range', 'timer'], required: true },
    start: { type: String, required: true }, // "HH:MM", 24 h
    end: String, // "HH:MM" for a time range (earlier than start = ends the next day)
    minutes: Number, // for a timer: how long it stays ON
  },
  { _id: false }
)

const scheduleSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    target: {
      _id: false,
      kind: { type: String, enum: ['group', 'room', 'floor', 'all'], required: true },
      id: String,
    },
    days: [{ type: Number, min: 0, max: 6 }], // 0 = Sunday … 6 = Saturday
    slots: [slotSchema],
    timezone: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    // ON/OFF times up to here are handled. Missed times (server asleep or restarting) are caught up
    // on the next check: only the latest one is applied, because it says how things should be now.
    handledUntil: { type: Date, default: Date.now },
    lastRun: {
      _id: false,
      at: Date, // when it ran
      due: Date, // the ON/OFF time it was for
      state: { type: String, enum: ['ON', 'OFF'] },
      sent: Number,
      queuedOffline: Number,
      skipped: Number, // groups kept ON because another schedule has them ON right now
      error: String,
    },
    createdBy: actorSchema,
  },
  { timestamps: true }
)
scheduleSchema.index({ enabled: 1 })

export const Schedule = model('Schedule', scheduleSchema)
