// Installs the website's own build toolchain (no Docker, no Arduino IDE on the server):
// arduino-cli + the exact board cores and libraries the firmware was compile-tested with.
//
//   npm run toolchain:install          (needs internet once; downloads ~2 GB, ~2.5 GB on disk afterwards)
//   npm run toolchain:install -- --keep-all-chips   (keep toolchains for other ESP32 chip families, ~6.5 GB)
//
// Everything goes into backend/tools (or ARDUINO_TOOLS_DIR). Safe to run again: installed parts are skipped.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { TOOLCHAIN } from '../lib/firmware/index.js'
import { cliConfigPath, cliEnv, cliPath } from '../services/firmware/builder.js'

const dir = config.arduinoToolsDir
const cli = cliPath()
const yaml = cliConfigPath()

function releaseAsset() {
  const v = TOOLCHAIN.arduinoCli
  const arch = os.arch()
  const name = {
    'darwin-arm64': 'macOS_ARM64.tar.gz',
    'darwin-x64': 'macOS_64bit.tar.gz',
    'linux-x64': 'Linux_64bit.tar.gz',
    'linux-arm64': 'Linux_ARM64.tar.gz',
    'linux-arm': 'Linux_ARMv7.tar.gz',
    'win32-x64': 'Windows_64bit.zip',
  }[`${process.platform}-${arch}`]
  if (!name) throw new Error(`No arduino-cli build for ${process.platform}-${arch}`)
  return { url: `https://github.com/arduino/arduino-cli/releases/download/v${v}/arduino-cli_${v}_${name}`, file: `arduino-cli_${v}_${name}` }
}

// The esp32 core ships toolchains for every ESP32 chip family. The school uses only the classic
// ESP32 (ESP32-D0WD, xtensa), so the RISC-V toolchain and the S2/S3/C3/C5/C6/H2/P4 libraries are removed
// (verified: esp32:esp32:esp32 still compiles without them).
const UNUSED_ESP32_TOOLS = ['esp-rv32', 'riscv32-esp-elf-gdb', 'esp32c3-libs', 'esp32c5-libs', 'esp32c6-libs', 'esp32h2-libs', 'esp32p4-libs', 'esp32p4_es-libs', 'esp32s2-libs', 'esp32s3-libs']

function installedCores() {
  const r = spawnSync(cli, ['--config-file', yaml, 'core', 'list', '--json'], { encoding: 'utf8', env: cliEnv() })
  try {
    const list = JSON.parse(r.stdout)
    return new Map((list.platforms ?? list ?? []).map((p) => [p.id, p.installed_version ?? p.installed]))
  } catch {
    return new Map()
  }
}

function run(args) {
  console.log(`$ arduino-cli ${args.join(' ')}`)
  const r = spawnSync(cli, ['--config-file', yaml, ...args], { stdio: 'inherit', env: cliEnv() })
  if (r.status !== 0) throw new Error(`arduino-cli ${args[0]} failed`)
}

async function main() {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })

  if (!fs.existsSync(cli)) {
    const { url, file } = releaseAsset()
    console.log(`Downloading ${url}`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Download failed: ${res.status}`)
    const archive = path.join(dir, file)
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()))
    // tar ships with macOS, Linux and Windows 10+ (and reads .zip on Windows)
    const r = spawnSync('tar', ['-xf', archive, '-C', path.join(dir, 'bin')], { stdio: 'inherit' })
    if (r.status !== 0) throw new Error('Could not unpack arduino-cli')
    fs.unlinkSync(archive)
  } else {
    console.log(`arduino-cli already present: ${cli}`)
  }

  // Board URLs only: the folders are given to arduino-cli at run time (see cliEnv), so moving the
  // project folder never breaks the toolchain.
  fs.writeFileSync(
    yaml,
    [
      'board_manager:',
      '  additional_urls:',
      `    - ${TOOLCHAIN.esp32.boardUrl}`,
      `    - ${TOOLCHAIN.esp8266.boardUrl}`,
      'network:',
      '  connection_timeout: 600s',
      '',
    ].join('\n')
  )

  run(['core', 'update-index'])
  const cores = installedCores()
  for (const [id, version] of [['esp8266:esp8266', TOOLCHAIN.esp8266.coreVersion], ['esp32:esp32', TOOLCHAIN.esp32.coreVersion]]) {
    if (cores.get(id) === version) console.log(`${id}@${version} already installed`)
    else run(['core', 'install', `${id}@${version}`])
  }
  run(['lib', 'install', ...TOOLCHAIN.libraries.map((l) => `${l.name}@${l.version}`)])

  if (!process.argv.includes('--keep-all-chips')) {
    const tools = path.join(dir, 'data', 'packages', 'esp32', 'tools')
    for (const t of UNUSED_ESP32_TOOLS) fs.rmSync(path.join(tools, t), { recursive: true, force: true })
  }
  fs.rmSync(path.join(dir, 'downloads'), { recursive: true, force: true }) // archives are not needed after install
  console.log(`\nToolchain ready in ${dir}. The website can now compile and upload firmware.`)
}

main().catch((err) => {
  console.error(`\nToolchain install failed: ${err.message}`)
  process.exit(1)
})
