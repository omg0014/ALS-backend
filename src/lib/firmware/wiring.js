import { pinLabel } from '../hardwareRules.js'

const inLabel = (profile, index) => (profile.channels === 1 ? 'IN' : `IN${index}`)

// ---- Wiring plan (reference for the electrician, never instructions for unqualified people) ----

export function wiringPlan({ profile, channels, groupsById = new Map() }) {
  const esp = profile.espModel === 'esp32' ? 'ESP32' : 'NodeMCU'
  const sorted = [...channels].sort((a, b) => a.index - b.index)
  const signal = sorted.map((c) => ({
    from: `${esp} ${pinLabel(profile.espModel, c.gpio)} (GPIO${c.gpio})`,
    to: `Relay ${inLabel(profile, c.index)}`,
    note: '',
  }))

  const power = []
  const jumpers = []
  const outputs = []
  if (profile.moduleKind === 'red30') {
    power.push({ from: '5V supply +', to: 'Relay DC+', note: '' }, { from: '5V supply − / common GND', to: 'Relay DC−', note: '' })
    jumpers.push('H/L jumper on H. In L mode at 3.3V the relay never releases (verified).')
  } else if (profile.moduleKind === 'blue2') {
    power.push({ from: '5V supply +', to: 'Relay 5V pad', note: '' }, { from: '5V supply − / common GND', to: 'Relay GND pad', note: '' })
    jumpers.push('No jumper on this module. 3.3V behaviour is unknown: bench-test before deployment.')
    jumpers.push('Solder header pins first. Never clamp female jumper ends in screw terminals.')
  } else if (profile.moduleKind === 'blue4') {
    power.push({ from: '5V supply +', to: 'Relay VCC (and JD-VCC via jumper)', note: '' }, { from: '5V supply − / common GND', to: 'Relay GND', note: '' })
    jumpers.push('Keep the JD-VCC jumper. If a channel turns ON but never OFF: remove the jumper, module VCC to 3V3, JD-VCC to 5V, GND common.')
  } else {
    power.push({ from: '5V supply +', to: 'Relay VCC', note: 'see profile setup notes' }, { from: '5V supply − / common GND', to: 'Relay GND', note: '' })
  }
  power.push(
    { from: '5V supply +', to: `${esp} 5V input (VIN)`, note: 'Field power; never laptop USB and the 5V supply at the same time' },
    { from: '5V supply −', to: `${esp} GND`, note: 'ESP and relay grounds always common' }
  )

  for (const c of sorted) {
    const g = c.lightingGroup ? groupsById.get(String(c.lightingGroup)) : null
    const k = profile.channels === 1 ? 'K1' : `K${c.index}`
    outputs.push({
      relay: `${k} / ${inLabel(profile, c.index)}`,
      com: 'Incoming phase (from terminal strip)',
      no: g ? `First switch of "${g.name}"${g.switches ? ` (${g.switches})` : ''}` : 'spare, not connected',
      nc: 'unused',
      group: g?.name ?? null,
    })
  }

  const supply =
    profile.moduleKind === 'red30' && profile.channels >= 2
      ? 'HLK-10M05 (5V 2A) for two 30A relays'
      : 'HLK-5M05 (5V 1A) for one 30A relay or a 10A multi-channel board'

  return {
    signal,
    power,
    outputs,
    jumpers,
    supply,
    mains: [
      `5V supply: ${supply}.`,
      'Its 230V input: phase taken before the relays, 1A slow-blow fuse in series, 14D471K varistor across L-N. A neutral must be brought to the box.',
      'Relay VCC from the 5V rail, never from the ESP 3V3 pin.',
      'Each relay NO feeds the first switch of its group; loop wires between groups are removed. NC unused. Neutral and switch-to-load wires are not changed.',
      'Relay OFF = whole group dead regardless of wall switches. Relay ON = wall switches and fan regulators work normally. MCB stays ON.',
      'All 230V work is done by an electrician. This sheet is a reference, not instructions for unqualified people.',
    ],
  }
}

// Bench checklist (PRD verification flow + module setup).
export function benchChecklist(profile) {
  return [
    'Each relay channel clicks when switched',
    'COM-NO closes when the channel is ON (continuity meter)',
    'No reboot when all channels switch together',
    profile.moduleKind === 'red30' ? 'H/L jumper is on H' : profile.moduleKind === 'blue4' ? 'JD-VCC jumper in place (or the JD-VCC fix applied)' : null,
    'ESP and relay grounds are common; relay VCC from the 5V rail',
    'Header pins in screw terminals, never female jumper ends',
  ].filter(Boolean)
}
