import { Floor, LightingGroup, Room, Schedule } from '../models/index.js'
import { switchTarget } from './commands.js'

// Runs the schedules: every few seconds, each active schedule whose ON or OFF time has come switches
// its target, through the same path as the ON/OFF buttons (so offline boards catch up when they are
// back, and every switch is in the activity log as "Schedule: <name>").
// Switching by hand is never blocked: a schedule only acts at its own ON and OFF times.
// Missed times (server asleep or restarting) are caught up on the next check: only the latest one is
// applied, because it says how things should be now (e.g. 9:00 ON and 9:30 OFF both missed → OFF).

const MIN = 60e3
const DAY = 24 * 60 * MIN
const CHECK_EVERY_MS = 15e3
const FIRST_CHECK_MS = 20e3 // after a restart, give the boards a moment to reconnect first
const CATCH_UP_DAYS = 8 // never look back further than this
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}

// A slot that only switches once: "ON at 8:30" or "OFF at 18:00" (no matching OFF / ON)
export const isSingle = (slot) => slot.kind === 'on' || slot.kind === 'off'

// How long a slot keeps its target ON, in minutes (a range that ends "earlier" ends the next day).
export function slotMinutes(slot) {
  if (isSingle(slot)) return 0
  return slot.kind === 'timer' ? slot.minutes : (toMinutes(slot.end) - toMinutes(slot.start) + 1440) % 1440
}

// ---- Wall-clock time in the school's time zone ----

const formats = new Map()
function wallClock(date, tz) {
  let f = formats.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(tz, f)
  }
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, weekday: WEEKDAYS.indexOf(p.weekday) }
}

// How far the time zone is ahead of UTC at that moment, in ms
function zoneOffset(date, tz) {
  const w = wallClock(date, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s) - Math.floor(date.getTime() / 1000) * 1000
}

// The moment the clock in `tz` shows that day at `minutes` past midnight
function atWallClock(y, m, d, minutes, tz) {
  const guess = Date.UTC(y, m - 1, d, 0, minutes)
  const first = guess - zoneOffset(new Date(guess), tz)
  return new Date(guess - zoneOffset(new Date(first), tz)) // second pass: right across daylight-saving changes
}

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// ---- When a schedule is ON ----

// The ON windows of slots that start on the days touching [from, to]. A single ON or OFF has no
// window, only its one time (`single`).
function windows(s, from, to) {
  const out = []
  const a = wallClock(new Date(from.getTime() - DAY), s.timezone) // a slot from the evening before can run into `from`
  const b = wallClock(to, s.timezone)
  const day = new Date(Date.UTC(a.y, a.m - 1, a.d))
  const last = Date.UTC(b.y, b.m - 1, b.d)
  for (; day.getTime() <= last; day.setUTCDate(day.getUTCDate() + 1)) {
    if (!s.days.includes(day.getUTCDay())) continue
    for (const slot of s.slots) {
      const on = atWallClock(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), toMinutes(slot.start), s.timezone)
      if (isSingle(slot)) out.push({ on, single: slot.kind === 'on' ? 'ON' : 'OFF', slot })
      else out.push({ on, off: new Date(on.getTime() + slotMinutes(slot) * MIN), slot })
    }
  }
  return out
}

// ON and OFF times after `from`, up to and including `to`, in order. When one slot ends as the next
// begins, OFF comes first, so the target stays ON.
export function eventsBetween(s, from, to) {
  return windows(s, from, to)
    .flatMap((w) =>
      w.single
        ? [{ at: w.on, state: w.single, slot: w.slot }]
        : [
            { at: w.on, state: 'ON', slot: w.slot },
            { at: w.off, state: 'OFF', slot: w.slot },
          ]
    )
    .filter((e) => e.at > from && e.at <= to)
    .sort((x, y) => x.at - y.at || (x.state === 'OFF' ? -1 : 1))
}

export const isOnAt = (s, t) => windows(s, t, t).some((w) => !w.single && w.on <= t && t < w.off)

export const nextEvents = (s, now, count = 2) => eventsBetween(s, now, new Date(now.getTime() + CATCH_UP_DAYS * DAY)).slice(0, count)

// ---- Targets ----

export async function groupIdsOf({ kind, id }) {
  if (kind === 'group') return (await LightingGroup.exists({ _id: id })) ? [String(id)] : []
  if (kind === 'room') return (await LightingGroup.find({ room: id }, '_id').lean()).map((g) => String(g._id))
  if (kind === 'floor') {
    const rooms = await Room.find({ floor: id }, '_id').lean()
    return (await LightingGroup.find({ room: { $in: rooms.map((r) => r._id) } }, '_id').lean()).map((g) => String(g._id))
  }
  return (await LightingGroup.find({}, '_id').lean()).map((g) => String(g._id))
}

// Name and floor of a target, for the list and for permission checks. null = it no longer exists.
export async function describeTarget({ kind, id }) {
  if (kind === 'all') return { label: 'Whole school', floorId: null }
  if (kind === 'floor') {
    const f = await Floor.findById(id, 'name').lean()
    return f && { label: f.name, floorId: String(f._id) }
  }
  if (kind === 'room') {
    const r = await Room.findById(id, 'displayName floor').lean()
    return r && { label: r.displayName, floorId: String(r.floor) }
  }
  const g = await LightingGroup.findById(id, 'name room').populate('room', 'displayName floor').lean()
  return g && { label: `${g.room?.displayName ?? '?'} / ${g.name}`, floorId: g.room ? String(g.room.floor) : null }
}

// ---- Running ----

let timer = null
let running = false

export function startScheduler() {
  timer = setTimeout(function check() {
    runDueSchedules().catch((err) => console.error('[schedule] check failed:', err.message))
    timer = setTimeout(check, CHECK_EVERY_MS)
  }, FIRST_CHECK_MS)
}

export function stopScheduler() {
  clearTimeout(timer)
}

export async function runDueSchedules(now = new Date()) {
  if (running) return
  running = true
  try {
    const active = await Schedule.find({ enabled: true }).lean()
    for (const s of active) {
      const from = new Date(Math.max(new Date(s.handledUntil).getTime(), now.getTime() - CATCH_UP_DAYS * DAY))
      const due = eventsBetween(s, from, now)
      if (!due.length) continue
      // Claim these times first, so a time is never applied twice
      const claimed = await Schedule.updateOne({ _id: s._id, enabled: true, handledUntil: s.handledUntil }, { $set: { handledUntil: now } })
      if (!claimed.modifiedCount) continue
      await apply(s, due.at(-1), now, active)
    }
  } finally {
    running = false
  }
}

async function apply(s, event, now, active) {
  const actor = { kind: 'schedule', name: `Schedule: ${s.name}` }
  const lastRun = { at: now, due: event.at, state: event.state, sent: 0, queuedOffline: 0, skipped: 0 }
  try {
    // Turning OFF: lines that another schedule has ON right now stay ON
    const keep = event.state === 'OFF' ? await groupsKeptOn(s, now, active) : new Set()
    const groups = await groupIdsOf(s.target)
    const kept = groups.filter((g) => keep.has(g))
    const targets = kept.length ? groups.filter((g) => !keep.has(g)).map((id) => ({ kind: 'group', id })) : [s.target]
    lastRun.skipped = kept.length
    for (const target of targets) {
      try {
        const r = await switchTarget({ target, state: event.state, actor })
        lastRun.sent += r.sent
        lastRun.queuedOffline += r.queuedOffline
      } catch (err) {
        // A line that is not connected to a board yet is skipped, the others still switch
        if (!(kept.length && err.status === 400)) throw err
      }
    }
    const at = event.at.toLocaleTimeString('en-GB', { timeZone: s.timezone, hour: '2-digit', minute: '2-digit' })
    console.log(`[schedule] "${s.name}": ${event.state} (due ${at}), ${lastRun.sent} sent, ${lastRun.queuedOffline} waiting for offline boards${kept.length ? `, ${kept.length} kept ON by another schedule` : ''}`)
  } catch (err) {
    lastRun.error = err.message
    console.warn(`[schedule] "${s.name}": ${event.state} failed: ${err.message}`)
  }
  await Schedule.updateOne({ _id: s._id }, { $set: { lastRun } })
}

async function groupsKeptOn(s, t, active) {
  const keep = new Set()
  for (const other of active) {
    if (String(other._id) === String(s._id) || !isOnAt(other, t)) continue
    for (const g of await groupIdsOf(other.target)) keep.add(g)
  }
  return keep
}
