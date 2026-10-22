// Set a new password for a user (e.g. a lost admin password). Run on the server:
//   npm run reset-password -- admin              → prints a new random password
//   npm run reset-password -- admin MyNewPass1   → uses the given one (min 8 characters)
import crypto from 'node:crypto'
import mongoose from 'mongoose'
import { config } from '../config.js'
import { User } from '../models/index.js'
import { hashPassword } from '../lib/crypto.js'

const [username = 'admin', given] = process.argv.slice(2)
if (given && given.length < 8) {
  console.error('Password must be at least 8 characters')
  process.exit(1)
}
const password = given || crypto.randomBytes(9).toString('base64url')

await mongoose.connect(config.mongoUrl)
const user = await User.findOne({ username: username.toLowerCase() })
if (!user) {
  console.error(`No user "${username}" in ${config.mongoUrl}`)
  process.exit(1)
}
user.passwordHash = await hashPassword(password)
user.active = true
await user.save()
console.log(`Password for "${user.username}" (${user.role}) set to: ${password}`)
console.log('Change it after signing in (the key icon next to your name in the menu).')
await mongoose.disconnect()
