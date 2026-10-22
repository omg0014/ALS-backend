import { Device, FirmwareBuild } from '../../models/index.js'
import { emit } from '../realtime.js'

// The board now runs the newest generated firmware: its secret becomes the only valid one, every
// config change made before that firmware was generated is on the board, and the build is installed.
// Built-in broker: noticed when the board logs in with the new secret. External broker (shared
// login): noticed when its telemetry reports the build ID baked into its config.h.
export async function markNewestFirmwareInstalled(device) {
  const issuedAt = device.pendingIssuedAt
  await Device.updateOne(
    { _id: device._id },
    {
      $set: { credentialHash: device.pendingCredentialHash, credentialsIssuedAt: issuedAt, pendingIssuedAt: null, pendingBuild: null },
      $unset: { pendingCredentialHash: 1 },
      $pull: { updateReasons: { at: { $lte: issuedAt } } },
    }
  )
  if (device.pendingBuild) {
    const now = new Date()
    const build = await FirmwareBuild.findByIdAndUpdate(device.pendingBuild, { $set: { installedAt: now } }, { returnDocument: 'after' })
    if (build && ['sent', 'downloading', 'started'].includes(build.ota?.status)) {
      build.ota.status = 'done'
      build.ota.doneAt = now
      await build.save()
    }
    emit('build', { buildId: String(device.pendingBuild), device: String(device._id) })
  }
  emit('devices:changed', {})
  console.log(`[mqtt] ${device.deviceId} is running its newest firmware`)
}
