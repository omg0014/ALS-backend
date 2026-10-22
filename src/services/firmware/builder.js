import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../config.js'
import { TOOLCHAIN } from '../../lib/firmware/index.js'

// The website's own "Arduino IDE": compiles generated sketches with a local arduino-cli
// (installed by `npm run toolchain:install`) and keeps the binaries for USB or WiFi upload.

const BUILD_TIMEOUT_MS = 10 * 60 * 1000
const KEEP_MS = 24 * 3600 * 1000
let queue = Promise.resolve()
let waiting = 0

export const cliPath = () => path.join(config.arduinoToolsDir, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli')
export const cliConfigPath = () => path.join(config.arduinoToolsDir, 'arduino-cli.yaml')
export const toolchainReady = () => fs.existsSync(cliPath()) && fs.existsSync(cliConfigPath())

// Folders are passed as environment variables (they override arduino-cli.yaml), so the project
// folder can be moved or renamed without breaking the installed toolchain.
export function cliEnv() {
  const dir = config.arduinoToolsDir
  return {
    ...process.env,
    ARDUINO_DIRECTORIES_DATA: path.join(dir, 'data'),
    ARDUINO_DIRECTORIES_DOWNLOADS: path.join(dir, 'downloads'),
    ARDUINO_DIRECTORIES_USER: path.join(dir, 'user'),
    ARDUINO_BUILD_CACHE_PATH: path.join(dir, 'cache'),
  }
}
export const buildDir = (buildId) => path.join(config.buildsDir, String(buildId))
export const binPath = (buildId, kind) => path.join(buildDir(buildId), `${kind}.bin`) // kind: usb | ota
export const queueLength = () => waiting

const md5 = (buf) => crypto.createHash('md5').update(buf).digest('hex')

// The ESP32 merged image is padded with 0xFF to the full 4 MB; flashing that padding over USB at
// 115200 baud only costs time, so trim it (to a 4 KB boundary).
function trimPadding(buf) {
  let end = buf.length
  while (end > 0 && buf[end - 1] === 0xff) end--
  return buf.subarray(0, Math.min(buf.length, Math.ceil(end / 4096) * 4096))
}

function runCli(args, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(cliPath(), ['--config-file', cliConfigPath(), ...args], { windowsHide: true, env: cliEnv() })
    const timer = setTimeout(() => {
      onOutput(`\nBuild stopped: it took longer than ${BUILD_TIMEOUT_MS / 60000} minutes.\n`)
      child.kill()
    }, BUILD_TIMEOUT_MS)
    child.stdout.on('data', (d) => onOutput(d.toString()))
    child.stderr.on('data', (d) => onOutput(d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      onOutput(`\n${err.message}\n`)
      resolve(-1)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

// files: [{ path: 'acls_firmware/acls_firmware.ino', content }]; the first path segment is the sketch folder.
// Resolves { ok, log, usb: { offset, size, md5 }, ota: { size, md5 } }. Jobs run one at a time.
export function compileSketch({ buildId, espModel, files, onStart }) {
  if (!toolchainReady()) {
    return Promise.resolve({ ok: false, log: 'Build toolchain not installed. Run `npm run toolchain:install` in the project folder.' })
  }
  waiting++
  const job = queue.then(async () => {
    waiting--
    onStart?.()
    const dir = buildDir(buildId)
    const src = path.join(dir, 'src')
    const out = path.join(dir, 'out')
    const sketch = files[0].path.split('/')[0]
    let log = ''
    try {
      fs.mkdirSync(out, { recursive: true })
      for (const f of files) {
        fs.mkdirSync(path.join(src, path.dirname(f.path)), { recursive: true })
        fs.writeFileSync(path.join(src, f.path), f.content)
      }
      const code = await runCli(['compile', '--fqbn', TOOLCHAIN[espModel].fqbn, '--output-dir', out, path.join(src, sketch)], (t) => {
        log = (log + t).slice(-20000)
      })
      if (code !== 0) return { ok: false, log }

      const app = fs.readFileSync(path.join(out, `${sketch}.ino.bin`))
      const usb = espModel === 'esp32' ? trimPadding(fs.readFileSync(path.join(out, `${sketch}.ino.merged.bin`))) : app
      fs.writeFileSync(binPath(buildId, 'usb'), usb)
      fs.writeFileSync(binPath(buildId, 'ota'), app)
      return { ok: true, log, usb: { offset: 0, size: usb.length, md5: md5(usb) }, ota: { size: app.length, md5: md5(app) } }
    } catch (err) {
      return { ok: false, log: `${log}\n${err.message}` }
    } finally {
      // Sources hold config.h (device secret, WiFi password): never keep them.
      fs.rmSync(src, { recursive: true, force: true })
      fs.rmSync(out, { recursive: true, force: true })
    }
  })
  queue = job.catch(() => {})
  return job
}

export function removeBuild(buildId) {
  fs.rmSync(buildDir(buildId), { recursive: true, force: true })
}

// Binaries contain the device secret and WiFi password, so they are deleted after a day.
export function cleanupOldBuilds() {
  if (!fs.existsSync(config.buildsDir)) return
  const cutoff = Date.now() - KEEP_MS
  for (const name of fs.readdirSync(config.buildsDir)) {
    const p = path.join(config.buildsDir, name)
    if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
  }
}
