import mongoose from 'mongoose'
import { ref, actorSchema } from './shared.js'

const { Schema, model } = mongoose

// One generated firmware package. The device secret is never stored: config.h is kept redacted.
const firmwareBuildSchema = new Schema({
  kind: { type: String, enum: ['firmware', 'test_sketch', 'custom'], default: 'firmware' },
  sketch: String, // test sketch kind (pin_test, led_chaser, wifi_test)
  device: ref('Device'),
  deviceId: String,
  profile: ref('HardwareProfile'),
  profileCode: String,
  version: String, // firmware template version
  configHash: String, // sha256 of the full config.h as downloaded
  configRedacted: String,
  wifiSsid: String,
  createdBy: actorSchema,
  createdAt: { type: Date, default: Date.now },
  // Website build service (arduino-cli on this server)
  compile: {
    _id: false,
    status: { type: String, enum: ['none', 'queued', 'compiling', 'ready', 'failed'], default: 'none' },
    log: String,
    startedAt: Date,
    finishedAt: Date,
    usb: { _id: false, offset: Number, size: Number, md5: String },
    ota: { _id: false, size: Number, md5: String },
  },
  // Over-the-air update of an installed board
  ota: {
    _id: false,
    status: { type: String, enum: ['none', 'waiting_build', 'sent', 'downloading', 'started', 'done', 'failed'], default: 'none' },
    token: { type: String, select: false },
    tokenExpires: Date,
    sentAt: Date,
    doneAt: Date,
    error: String,
  },
  installedAt: Date, // the board logged in with this build's credentials (USB or OTA)
})
firmwareBuildSchema.index({ device: 1, createdAt: -1 })

export const FirmwareBuild = model('FirmwareBuild', firmwareBuildSchema)
