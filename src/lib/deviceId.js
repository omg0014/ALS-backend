import { badRequest } from './errors.js'

// Device ID = "acls-" + chip ID in hex (last 3 bytes of the WiFi MAC, as printed by the firmware at boot).
export function normaliseDeviceId(input) {
  const hex = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/^acls-/, '')
    .replace(/^0x/, '')
  if (!/^[0-9a-f]{1,6}$/.test(hex)) throw badRequest('Chip ID must be up to 6 hex digits, e.g. 3fa2c1 (shown in the serial log at boot)')
  return `acls-${hex.padStart(6, '0')}`
}
