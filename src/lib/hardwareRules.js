// Pin and load rules from the PRD "Hardware reference" and "Electrical wiring model".
// Do not change these without a written reason: they were verified on real hardware.

// ESP8266 (NodeMCU): D1, D2, D5, D6, D7 only. Never D3/GPIO0, D4/GPIO2, D8/GPIO15 (boot pins); avoid RX/TX and D0.
export const ESP8266_ALLOWED_PINS = [
  { label: 'D1', gpio: 5 },
  { label: 'D2', gpio: 4 },
  { label: 'D5', gpio: 14 },
  { label: 'D6', gpio: 12 },
  { label: 'D7', gpio: 13 },
]

// ESP32: never 0, 2, 5, 12, 15 (strapping), 6-11 (flash), 1, 3 (UART), 34-39 (input only).
export const ESP32_ALLOWED_GPIOS = [16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33]

export function allowedPins(espModel) {
  if (espModel === 'esp8266') return ESP8266_ALLOWED_PINS
  if (espModel === 'esp32') return ESP32_ALLOWED_GPIOS.map((g) => ({ label: `D${g}`, gpio: g }))
  return []
}

export function isAllowedGpio(espModel, gpio) {
  return allowedPins(espModel).some((p) => p.gpio === Number(gpio))
}

export function pinLabel(espModel, gpio) {
  return allowedPins(espModel).find((p) => p.gpio === Number(gpio))?.label ?? `GPIO${gpio}`
}

// Warnings shown (never hidden) when a lighting group is assigned to a relay channel.
export function loadWarnings(profile, group) {
  const warnings = []
  if (!profile || !group) return warnings
  const amps = Number(group.estimatedAmps) || 0
  if (profile.contactRatingA && amps > profile.contactRatingA) {
    warnings.push(`Estimated load ${amps}A is above the relay contact rating (${profile.contactRatingA}A).`)
  } else if (profile.maxAmpsPerChannel && amps > profile.maxAmpsPerChannel) {
    warnings.push(
      `Estimated load ${amps}A is above the recommended ${profile.maxAmpsPerChannel}A per channel for this module. ` +
        'Split the circuit across channels or use a contactor.'
    )
  }
  if (profile.contactRatingA >= 30 && group.type !== 'load') {
    warnings.push('30A module is meant for TV / smart-board points only (group type "load").')
  }
  return warnings
}
