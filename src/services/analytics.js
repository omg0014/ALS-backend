import { Channel, Command, DeviceState, Floor, LightingGroup, OnPeriod, Room, Setting } from '../models/index.js'

// ON-time history for Analytics. Every state report of a board goes through recordStates(): a line
// whose relay is ON gets an open period, and the period is closed when it reports OFF or the board
// goes offline (what happens while a board is offline is not known, so it is not counted).

const VOLTS = 230
const HOUR = 3600e3
const DAY = 24 * HOUR

async function lineInfo(groupIds) {
  const groups = await LightingGroup.find({ _id: { $in: groupIds } }).lean()
  const rooms = await Room.find({ _id: { $in: groups.map((g) => g.room) } }, 'floor').lean()
  const floorOf = new Map(rooms.map((r) => [String(r._id), r.floor]))
  return new Map(groups.map((g) => [String(g._id), { group: g._id, room: g.room, floor: floorOf.get(String(g.room)) ?? null, type: g.type, amps: g.estimatedAmps || 0 }]))
}

// channelStates: [0|1, …] for relays 1…n, as the board reported them
export async function recordStates(deviceId, channelStates, at = new Date()) {
  const [channels, open] = await Promise.all([
    Channel.find({ device: deviceId }).lean(),
    OnPeriod.find({ device: deviceId, end: null }).lean(),
  ])
  const openOf = new Map(open.map((p) => [p.channel, p]))
  const toOpen = channels.filter((c) => channelStates[c.index - 1] === 1 && c.lightingGroup && !openOf.has(c.index))
  const toClose = open.filter((p) => channelStates[p.channel - 1] !== 1)
  if (toClose.length) await OnPeriod.updateMany({ _id: { $in: toClose.map((p) => p._id) } }, { $set: { end: at } })
  if (toOpen.length) {
    const info = await lineInfo(toOpen.map((c) => c.lightingGroup))
    const docs = toOpen.map((c) => ({ device: deviceId, channel: c.index, ...info.get(String(c.lightingGroup)), start: at })).filter((d) => d.group)
    if (docs.length) await OnPeriod.insertMany(docs)
  }
}

// Board offline / removed, or one relay moved to another line: stop counting from now
export const closeDevicePeriods = (deviceId, at = new Date()) => OnPeriod.updateMany({ device: deviceId, end: null }, { $set: { end: at } })
export const closeChannelPeriod = (deviceId, channel, at = new Date()) => OnPeriod.updateMany({ device: deviceId, channel, end: null }, { $set: { end: at } })

// At start-up nobody is online yet: close what was open at the moment each board was last heard from.
export async function closeStalePeriods() {
  const open = await OnPeriod.find({ end: null }).lean()
  if (!open.length) return
  const states = await DeviceState.find({ device: { $in: [...new Set(open.map((p) => String(p.device)))] } }, 'device lastSeen').lean()
  const lastSeen = new Map(states.map((s) => [String(s.device), s.lastSeen]))
  for (const p of open) {
    const seen = lastSeen.get(String(p.device))
    await OnPeriod.updateOne({ _id: p._id }, { $set: { end: seen && seen > p.start ? seen : p.start } })
  }
}

// Once: rebuild the history from confirmed switch commands, for the time before this log existed.
export async function backfillFromCommands() {
  if (await Setting.exists({ key: 'analyticsBackfilled' })) return
  if (!(await OnPeriod.exists({}))) {
    const cmds = await Command.find({ result: 'confirmed', confirmedAt: { $ne: null }, lightingGroup: { $ne: null } }).sort({ confirmedAt: 1 }).lean()
    const info = await lineInfo([...new Set(cmds.map((c) => String(c.lightingGroup)))])
    const open = new Map()
    const docs = []
    for (const c of cmds) {
      const key = `${c.device}:${c.channel}`
      const o = open.get(key)
      if (c.desired === 'ON' && !o) {
        const line = info.get(String(c.lightingGroup))
        if (line) open.set(key, { device: c.device, channel: c.channel, ...line, start: c.confirmedAt, end: null, backfilled: true })
      } else if (c.desired === 'OFF' && o) {
        docs.push({ ...o, end: c.confirmedAt })
        open.delete(key)
      }
    }
    // Still ON at the end of the history: count it until the board was last heard from
    const states = await DeviceState.find({}, 'device lastSeen').lean()
    const lastSeen = new Map(states.map((s) => [String(s.device), s.lastSeen]))
    for (const o of open.values()) docs.push({ ...o, end: lastSeen.get(String(o.device)) > o.start ? lastSeen.get(String(o.device)) : o.start })
    if (docs.length) await OnPeriod.insertMany(docs)
    if (docs.length) console.log(`[analytics] rebuilt ${docs.length} ON period(s) from the switching history`)
  }
  await Setting.updateOne({ key: 'analyticsBackfilled' }, { $set: { value: new Date() } }, { upsert: true })
}

// ---- Report ----

// Splits [s, e) at local midnights (tzOffset = the browser's getTimezoneOffset(), minutes)
function* byLocalDay(s, e, tzOffset) {
  const shift = -tzOffset * 60e3
  let t = s
  while (t < e) {
    const dayStart = Math.floor((t + shift) / DAY) * DAY - shift
    const next = Math.min(dayStart + DAY, e)
    yield [new Date(dayStart + shift).toISOString().slice(0, 10), next - t]
    t = next
  }
}

// Union length of intervals (time "something was on")
function unionMs(intervals) {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let [cs, ce] = sorted[0] ?? [0, 0]
  for (const [s, e] of sorted.slice(1)) {
    if (s > ce) {
      total += ce - cs
      ;[cs, ce] = [s, e]
    } else ce = Math.max(ce, e)
  }
  return sorted.length ? total + (ce - cs) : 0
}

const hours = (ms) => Math.round((ms / HOUR) * 1e4) / 1e4
const kwh = (ms, amps) => (ms / HOUR) * amps * VOLTS / 1000

export async function analyticsReport({ from, to, tzOffset = 0, floor, type, room }) {
  const now = Date.now()
  const fromMs = from.getTime()
  const toMs = Math.min(to.getTime(), now)
  const [floors, rooms, groups] = await Promise.all([
    Floor.find().sort({ order: 1, name: 1 }).lean(),
    Room.find(floor ? { floor } : {}).sort({ displayName: 1 }).lean(),
    LightingGroup.find(type ? { type } : {}).lean(),
  ])
  const roomIds = new Set(rooms.filter((r) => !room || String(r._id) === String(room)).map((r) => String(r._id)))
  const shownGroups = groups.filter((g) => roomIds.has(String(g.room)))
  const filter = { start: { $lt: new Date(toMs) }, $or: [{ end: null }, { end: { $gt: from } }] }
  if (floor) filter.floor = floor
  if (type) filter.type = type
  if (room) filter.room = room
  const periods = await OnPeriod.find(filter).lean()

  const line = new Map(shownGroups.map((g) => [String(g._id), { group: g._id, name: g.name, type: g.type, room: g.room, amps: g.estimatedAmps || 0, ms: 0, kwh: 0, switchedOn: 0 }]))
  const roomAgg = new Map()
  const floorAgg = new Map()
  const daily = new Map()
  const roomIntervals = new Map()
  const floorIntervals = new Map()
  const openNow = []
  for (const p of periods) {
    const s = Math.max(p.start.getTime(), fromMs)
    const e = Math.min(p.end ? p.end.getTime() : now, toMs)
    if (e <= s || !roomIds.has(String(p.room))) continue
    const ms = e - s
    const energy = kwh(ms, p.amps)
    const rk = String(p.room)
    const fk = String(p.floor)
    const l = line.get(String(p.group))
    if (l) {
      l.ms += ms
      l.kwh += energy
      if (p.start.getTime() >= fromMs) l.switchedOn += 1
    }
    const r = roomAgg.get(rk) ?? { ms: 0, kwh: 0, byType: {} }
    r.ms += ms
    r.kwh += energy
    r.byType[p.type] = (r.byType[p.type] ?? 0) + ms
    roomAgg.set(rk, r)
    const f = floorAgg.get(fk) ?? { ms: 0, kwh: 0, byType: {} }
    f.ms += ms
    f.kwh += energy
    f.byType[p.type] = (f.byType[p.type] ?? 0) + ms
    floorAgg.set(fk, f)
    ;(roomIntervals.get(rk) ?? roomIntervals.set(rk, []).get(rk)).push([s, e])
    ;(floorIntervals.get(fk) ?? floorIntervals.set(fk, []).get(fk)).push([s, e])
    for (const [day, part] of byLocalDay(s, e, tzOffset)) {
      const d = daily.get(day) ?? {}
      d[p.type] = (d[p.type] ?? 0) + part
      daily.set(day, d)
    }
    if (!p.end) openNow.push({ group: p.group, room: p.room, since: p.start })
  }

  const typeHours = (byType) => Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, hours(v)]))
  const floorName = new Map(floors.map((f) => [String(f._id), f.name]))
  const roomRows = rooms
    .filter((r) => roomIds.has(String(r._id)))
    .map((r) => {
      const a = roomAgg.get(String(r._id)) ?? { ms: 0, kwh: 0, byType: {} }
      return {
        room: r._id,
        name: r.displayName,
        floor: r.floor,
        floorName: floorName.get(String(r.floor)) ?? '',
        lineHours: hours(a.ms),
        anyOnHours: hours(unionMs(roomIntervals.get(String(r._id)) ?? [])),
        kwh: Math.round(a.kwh * 10) / 10,
        byType: typeHours(a.byType),
        lines: shownGroups.filter((g) => String(g.room) === String(r._id)).length,
      }
    })
  const floorRows = floors
    .filter((f) => !floor || String(f._id) === String(floor))
    .map((f) => {
      const a = floorAgg.get(String(f._id)) ?? { ms: 0, kwh: 0, byType: {} }
      const inFloor = roomRows.filter((r) => String(r.floor) === String(f._id))
      const busiest = [...inFloor].sort((x, y) => y.lineHours - x.lineHours)[0]
      return {
        floor: f._id,
        name: f.name,
        lineHours: hours(a.ms),
        anyOnHours: hours(unionMs(floorIntervals.get(String(f._id)) ?? [])),
        kwh: Math.round(a.kwh * 10) / 10,
        byType: typeHours(a.byType),
        rooms: inFloor.length,
        busiestRoom: busiest?.lineHours ? busiest.name : null,
      }
    })
    .filter((f) => f.rooms > 0 || f.lineHours > 0)
  const totalMs = [...roomAgg.values()].reduce((a, r) => a + r.ms, 0)
  const totalKwh = [...roomAgg.values()].reduce((a, r) => a + r.kwh, 0)

  // Every day of the range, also the ones with nothing on
  const days = []
  for (const [day] of byLocalDay(fromMs, toMs, tzOffset)) {
    const d = daily.get(day) ?? {}
    days.push({ date: day, byType: typeHours(d), lineHours: hours(Object.values(d).reduce((a, v) => a + v, 0)) })
  }

  return {
    range: { from: new Date(fromMs), to: new Date(toMs) },
    totals: {
      lineHours: hours(totalMs),
      kwh: Math.round(totalKwh * 10) / 10,
      rooms: roomRows.length,
      lines: shownGroups.length,
      linesWithoutLoad: shownGroups.filter((g) => !g.estimatedAmps).length,
      onNow: openNow.length,
    },
    floors: floorRows,
    rooms: roomRows,
    lines: [...line.values()].map((l) => ({ ...l, ms: undefined, hours: hours(l.ms), kwh: Math.round(l.kwh * 10) / 10 })),
    days,
  }
}
