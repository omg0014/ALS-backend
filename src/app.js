import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import mongoose from 'mongoose'
import { config } from './config.js'
import { errorHandler } from './lib/errors.js'
import { requireAuth } from './lib/auth.js'
import { otaDownload } from './services/firmware/jobs.js'
import { binPath } from './services/firmware/builder.js'
import authRoutes from './routes/auth.js'
import overviewRoutes from './routes/overview.js'
import buildingRoutes from './routes/building.js'
import deviceRoutes from './routes/devices.js'
import controlRoutes from './routes/control.js'
import profileRoutes from './routes/profiles.js'
import firmwareRoutes from './routes/firmware.js'
import draftRoutes from './routes/drafts.js'
import installRoutes from './routes/install.js'
import guideRoutes from './routes/guides.js'
import auditRoutes from './routes/audit.js'
import userRoutes from './routes/users.js'
import settingRoutes from './routes/settings.js'
import codeRoutes from './routes/code.js'

// The web application: REST API under /api, the board's OTA download, and the built website.
export function createApp() {
  const app = express()
  app.set('trust proxy', config.trustProxy)
  // Plain HTTP on the school LAN: don't make browsers upgrade requests to HTTPS.
  app.use(helmet({ contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } }, hsts: false }))
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())

  // ---- No login needed ----
  app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }))
  // Firmware download for an over-the-air update. The board has no login here: the URL carries a
  // random one-time token (15 min) sent only to that board over its private MQTT topic.
  app.get('/ota/:token', async (req, res) => {
    const build = await otaDownload(req.params.token)
    if (!build) return res.status(404).end()
    res.set('x-MD5', build.compile.ota.md5)
    res.type('application/octet-stream').sendFile(binPath(build._id, 'ota'))
  })
  app.use('/api/auth', authRoutes) //               login, logout, me, change password

  // ---- Logged-in users (each route checks the role it needs) ----
  app.use('/api', requireAuth)
  app.use('/api', overviewRoutes) //                 /overview, /alerts
  app.use('/api', buildingRoutes) //                 /floors, /rooms, /groups
  app.use('/api/devices', deviceRoutes) //           devices, channel mapping, retire, replace board
  app.use('/api/control', controlRoutes) //          switch group / room / floor / school
  app.use('/api/profiles', profileRoutes) //         hardware profiles
  app.use('/api', firmwareRoutes) //                 firmware packages, builds, OTA, test sketches, wiring
  app.use('/api', draftRoutes) //                    /drafts (wizard progress)
  app.use('/api', installRoutes) //                  room installation steps, bench test, commissioning
  app.use('/api/guides', guideRoutes) //             help guides
  app.use('/api', auditRoutes) //                    /audit/commands, /audit/changes
  app.use('/api', userRoutes) //                     /users (admin)
  app.use('/api', settingRoutes) //                  /settings
  app.use('/api', codeRoutes) //                     /code/compile, /sketches (code editor, admin)
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }))
  app.use(errorHandler)

  // ---- The website (frontend/dist), served by this same process: one `npm start` runs everything ----
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }))
    app.get(/^(?!\/api|\/socket\.io).*/, (req, res) => res.sendFile(path.join(config.webDist, 'index.html')))
    console.log(`[web] serving ${config.webDist}`)
  } else {
    console.warn(`[web] ${config.webDist} not found: run "npm run build" in frontend/ (or "npm run setup" in the project folder)`)
  }
  return app
}
