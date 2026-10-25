import mongoose from 'mongoose'
import { ref } from './shared.js'

const { Schema, model } = mongoose

// One ESP relay box, identified by "acls-" + its chip ID. A "simple" board runs its own code: the
// website only publishes an ON/OFF message to its MQTT topic (ID "mqtt-" + 6 random hex digits).
const deviceSchema = new Schema(
  {
    deviceId: { type: String, required: true, unique: true, match: /^(acls|mqtt)-[0-9a-f]{6}$/ },
    kind: { type: String, enum: ['acls', 'simple'], default: 'acls' },
    simple: {
      _id: false,
      url: String, // mqtt://host:1883 or mqtts://host:8883
      username: String,
      passwordEnc: { type: String, select: false },
      commandTopic: String,
      stateTopic: String, // optional: where the board reports ON/OFF back
      onPayload: String,
      offPayload: String,
      retain: Boolean, // keep the last command on the broker, so a restarted board switches back
      synced: Boolean, // first state report seen (taken as the starting state, never overridden)
    },
    name: { type: String, required: true, trim: true },
    room: { ...ref('Room'), default: null },
    profile: { ...ref('HardwareProfile'), required: true },
    mqttUsername: { type: String, required: true, unique: true },
    credentialHash: { type: String, select: false },
    credentialsIssuedAt: { type: Date, default: null },
    // Secret inside the newest generated firmware. Accepted alongside the current one until the board
    // logs in with it, so a running board keeps working until the new firmware is on it (USB or OTA).
    pendingCredentialHash: { type: String, select: false },
    pendingIssuedAt: { type: Date, default: null },
    pendingBuild: { type: Schema.Types.ObjectId, ref: 'FirmwareBuild', default: null },
    firmwareVersion: { type: String, default: '' },
    mac: { type: String, default: '' },
    installedOn: { type: Date, default: null },
    status: { type: String, enum: ['active', 'spare', 'retired'], default: 'active' },
    previousIds: { type: [String], default: [] }, // boards this record replaced ("Replace device")
    // Why a re-flash is needed; cleared once the board connects with credentials issued after the reason.
    updateReasons: [{ _id: false, reason: String, at: { type: Date, default: Date.now } }],
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
)
deviceSchema.virtual('updateNeeded').get(function () {
  return (this.updateReasons?.length ?? 0) > 0
})

export const Device = model('Device', deviceSchema)
