// Daily database backup (PRD: daily backup, audit kept 1 year). Needs MongoDB Database Tools (mongodump).
//   npm run backup                 → backups/acls-YYYY-MM-DD.archive.gz, keeps the newest BACKUP_KEEP_DAYS (30)
// Schedule it once a day with cron (Linux/macOS) or Task Scheduler (Windows); see README.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const dir = process.env.BACKUP_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backups')
const keepDays = Number(process.env.BACKUP_KEEP_DAYS || 30)
fs.mkdirSync(dir, { recursive: true })

const file = path.join(dir, `acls-${new Date().toISOString().slice(0, 10)}.archive.gz`)
const r = spawnSync('mongodump', [`--uri=${config.mongoUrl}`, `--archive=${file}`, '--gzip'], { stdio: 'inherit' })
if (r.error || r.status !== 0) {
  console.error('backup failed:', r.error?.message ?? `mongodump exited with ${r.status}`)
  process.exit(1)
}
console.log(`backup written: ${file}`)

const cutoff = Date.now() - keepDays * 86400e3
for (const f of fs.readdirSync(dir)) {
  const p = path.join(dir, f)
  if (/^acls-\d{4}-\d{2}-\d{2}\.archive\.gz$/.test(f) && fs.statSync(p).mtimeMs < cutoff) {
    fs.unlinkSync(p)
    console.log(`removed old backup ${f}`)
  }
}
