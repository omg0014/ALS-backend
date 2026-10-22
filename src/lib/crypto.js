import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)

// User passwords: scrypt with a per-password salt.
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password, stored) {
  if (!stored?.startsWith('scrypt$')) return false
  const [, saltHex, hashHex] = stored.split('$')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length)
  return crypto.timingSafeEqual(expected, actual)
}

// Device secrets are 32 random bytes, so a fast hash is enough and keeps
// 300 devices reconnecting after a power cut cheap to authenticate.
export function generateDeviceSecret() {
  return crypto.randomBytes(24).toString('base64url')
}

export function hashDeviceSecret(secret) {
  return `sha256$${crypto.createHash('sha256').update(secret).digest('hex')}`
}

export function verifyDeviceSecret(secret, stored) {
  if (!stored) return false
  const a = Buffer.from(hashDeviceSecret(secret))
  const b = Buffer.from(stored)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const newId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex')
