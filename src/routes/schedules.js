import { Router } from 'express'
import { Schedule } from '../models/index.js'
import { EDITOR, canUseFloor } from '../lib/auth.js'
import { badRequest, forbidden, notFound } from '../lib/errors.js'
import { actorOf, logChange } from '../services/changeLog.js'
import { describeTarget, isOnAt, isValidTimeZone, nextEvents, slotMinutes, toMinutes } from '../services/scheduler.js'

// Schedules: switch a line, a classroom, a floor or the whole school ON and OFF at set times.
// Everyone sees them; staff and admins add and change them (floor and whole-school ones: admin only,
// like the ON/OFF buttons).
const router = Router()

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_SLOTS = 12
const MAX_TIMER_MIN = 720

async function view(s, now) {
  const target = await describeTarget(s.target)
  return {
    ...s,
    targetLabel: target?.label ?? null, // null: the line, room or floor was deleted
    floorId: target?.floorId ?? null,
    onNow: s.enabled && Boolean(target) && isOnAt(s, now),
    next: s.enabled && target ? nextEvents(s, now).map((e) => ({ at: e.at, state: e.state })) : [],
  }
}

// Checks and tidies what the form sent. Returns the fields to save.
async function readSchedule(req) {
  const b = req.body ?? {}
  const name = String(b.name ?? '').trim()
  if (!name) throw badRequest('Give the schedule a name, e.g. "10-B school day"')
  if (name.length > 60) throw badRequest('The name is too long (60 characters at most)')

  const kind = b.target?.kind
  if (!['group', 'room', 'floor', 'all'].includes(kind)) throw badRequest('Choose what it switches')
  const target = { kind, id: kind === 'all' ? undefined : String(b.target.id ?? '') }
  if (['floor', 'all'].includes(kind) && req.user.role !== 'admin') throw forbidden('Only an admin can schedule a whole floor or the school')
  const described = await describeTarget(target).catch(() => null)
  if (!described) throw badRequest('That line, classroom or floor no longer exists')
  if (described.floorId && !canUseFloor(req.user, described.floorId)) throw forbidden('You are not allowed to control this floor')

  const days = [...new Set((Array.isArray(b.days) ? b.days : []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort()
  if (!days.length) throw badRequest('Choose at least one day')

  const slots = (Array.isArray(b.slots) ? b.slots : []).map((x, i) => {
    const n = `Time ${i + 1}`
    if (!TIME.test(x?.start ?? '')) throw badRequest(`${n}: enter the ON time`)
    if (x.kind === 'timer') {
      const minutes = Math.round(Number(x.minutes))
      if (!(minutes >= 1 && minutes <= MAX_TIMER_MIN)) throw badRequest(`${n}: the timer must be 1 to ${MAX_TIMER_MIN} minutes (12 hours)`)
      return { kind: 'timer', start: x.start, minutes }
    }
    if (x.kind !== 'range') throw badRequest(`${n}: choose "From … to …" or "Timer"`)
    if (!TIME.test(x.end ?? '')) throw badRequest(`${n}: enter the OFF time`)
    if (x.end === x.start) throw badRequest(`${n}: the OFF time must be different from the ON time`)
    return { kind: 'range', start: x.start, end: x.end }
  })
  if (!slots.length) throw badRequest('Add at least one ON time')
  if (slots.length > MAX_SLOTS) throw badRequest(`At most ${MAX_SLOTS} times per schedule`)
  checkNoOverlap(slots, days)

  const timezone = String(b.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone)
  if (!isValidTimeZone(timezone)) throw badRequest(`Unknown time zone "${timezone}"`)
  return { name, target, days, slots, timezone }
}

// Two times of the same schedule may not overlap on any day (e.g. 9:00–10:00 and 9:30 for 30 min).
// One may start exactly when the other ends.
function checkNoOverlap(slots, days) {
  const WEEK = 7 * 1440
  const spans = days.flatMap((d) => slots.map((s, i) => ({ i, from: d * 1440 + toMinutes(s.start), len: slotMinutes(s) })))
  const fmt = (s) => (s.kind === 'timer' ? `${s.start} for ${s.minutes} min` : `${s.start}–${s.end}`)
  for (let a = 0; a < spans.length; a++) {
    for (let b = a + 1; b < spans.length; b++) {
      const x = spans[a]
      const y = spans[b]
      if (x.i === y.i) continue
      const hit = [-WEEK, 0, WEEK].some((shift) => x.from < y.from + shift + y.len && y.from + shift < x.from + x.len)
      if (hit) throw badRequest(`"${fmt(slots[x.i])}" and "${fmt(slots[y.i])}" overlap. Change one, or make one start when the other ends`)
    }
  }
}

async function findEditable(req) {
  const s = await Schedule.findById(req.params.id)
  if (!s) throw notFound('Schedule not found')
  if (['floor', 'all'].includes(s.target.kind) && req.user.role !== 'admin') throw forbidden('Only an admin can change a floor or whole-school schedule')
  const described = await describeTarget(s.target)
  if (described?.floorId && !canUseFloor(req.user, described.floorId)) throw forbidden('You are not allowed to control this floor')
  return s
}

router.get('/schedules', async (req, res) => {
  const now = new Date()
  const list = await Schedule.find().sort({ createdAt: 1 }).lean()
  res.json({ now, schedules: await Promise.all(list.map((s) => view(s, now))) })
})

router.post('/schedules', EDITOR, async (req, res) => {
  const fields = await readSchedule(req)
  // It acts from its next ON or OFF time on (a time already passed today is not applied now)
  const s = await Schedule.create({ ...fields, enabled: req.body?.enabled !== false, handledUntil: new Date(), createdBy: actorOf(req) })
  await logChange(req, 'schedule', 'create', null, s)
  res.status(201).json(await view(s.toObject(), new Date()))
})

router.put('/schedules/:id', EDITOR, async (req, res) => {
  const s = await findEditable(req)
  const before = s.toObject()
  s.set({ ...(await readSchedule(req)), handledUntil: new Date() })
  await s.save()
  await logChange(req, 'schedule', 'update', before, s)
  res.json(await view(s.toObject(), new Date()))
})

// Pause or resume. Resuming starts from now: times missed while paused are not applied.
router.patch('/schedules/:id', EDITOR, async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') throw badRequest('enabled must be true or false')
  const s = await findEditable(req)
  const before = s.toObject()
  s.enabled = req.body.enabled
  if (s.enabled) s.handledUntil = new Date()
  await s.save()
  await logChange(req, 'schedule', 'update', before, s)
  res.json(await view(s.toObject(), new Date()))
})

router.delete('/schedules/:id', EDITOR, async (req, res) => {
  const s = await findEditable(req)
  await s.deleteOne()
  await logChange(req, 'schedule', 'delete', s, null)
  res.json({ ok: true })
})

export default router
