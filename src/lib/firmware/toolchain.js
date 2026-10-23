import fs from 'node:fs'
import path from 'node:path'
import { config } from '../../config.js'

// Toolchain the firmware is built with (website build service and the Arduino IDE guide), plus
// the per-board upload instructions.

export const TOOLCHAIN = {
  arduinoCli: '1.5.1', // used by the website's own build service (npm run toolchain:install)
  esp32: {
    fqbn: 'esp32:esp32:esp32',
    boardName: 'ESP32 Dev Module',
    core: 'esp32 by Espressif Systems',
    coreVersion: '3.3.12',
    boardUrl: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
    driver: 'WCH CH34x / CH9102 driver (macOS)',
    button: 'BOOT',
    uploadNote: 'Upload speed 115200. 921600 fails on these boards.',
  },
  esp8266: {
    fqbn: 'esp8266:esp8266:nodemcuv2',
    boardName: 'NodeMCU 1.0 (ESP-12E Module)',
    core: 'esp8266 by ESP8266 Community',
    coreVersion: '3.1.2',
    boardUrl: 'https://arduino.esp8266.com/stable/package_esp8266com_index.json',
    driver: 'WCH CH34x driver (CH340, macOS)',
    button: 'FLASH',
    uploadNote: 'Upload speed 115200.',
  },
  libraries: [
    { name: 'PubSubClient', author: "Nick O'Leary", version: '2.8' },
    { name: 'ArduinoJson', author: 'Benoit Blanchon', version: '7.4.3' },
  ],
  // Extra libraries for the code editor's own programs only (IR remote / AC tests); the ACLS firmware does not use them
  editorLibraries: [{ name: 'IRremoteESP8266', author: 'David Conran', version: '2.9.0' }],
}

export function readFirmwareFile(...parts) {
  return fs.readFileSync(path.join(config.firmwareDir, ...parts), 'utf8')
}

// The firmware version lives in the template itself (#define ACLS_FW_VERSION), so it can't drift from the code.
export function templateVersion() {
  return readFirmwareFile('acls_firmware', 'acls_firmware.ino').match(/#define ACLS_FW_VERSION "([^"]+)"/)?.[1] ?? '0.0.0'
}

// ---- Arduino IDE upload guide (path A) ----

export function expectedBootLog({ profile, deviceId, wifiSsid, settings, channels }) {
  return [
    `ACLS firmware ${settings.firmwareVersion}, profile ${profile.code} v${profile.version}, ${channels} relay channel(s)`,
    `Device ID: ${deviceId} (chip ID ${deviceId.slice(5)})`,
    `WiFi: connecting to "${wifiSsid}"....`,
    'WiFi: connected, IP 192.168.x.x, RSSI -60 dBm',
    `MQTT: connecting to ${settings.brokerHost}:${settings.brokerPort} as ${deviceId}`,
    'MQTT: connected, waiting for commands',
  ].join('\n')
}

export function arduinoSteps(espModel) {
  const t = TOOLCHAIN[espModel]
  return [
    `Install Arduino IDE 2. In Settings → "Additional boards manager URLs" add ${t.boardUrl}`,
    `Boards Manager: install "${t.core}" version ${t.coreVersion}.`,
    `Install the USB driver: ${t.driver}.`,
    `Library Manager: install ${TOOLCHAIN.libraries.map((l) => `${l.name} (${l.author}) ${l.version}`).join(' and ')}.`,
    'Unzip the download and open acls_firmware/acls_firmware.ino (config.h opens as a second tab). Do not edit either file.',
    `Tools → Board: "${t.boardName}". Port: the new usbserial / wchusbserial port. ${t.uploadNote}`,
    `Upload. If it is stuck at "Connecting…", hold ${t.button} and tap RST.`,
    'Open Serial Monitor at 115200 and check the boot log below.',
    'Unplug USB, connect the field 5V supply, and confirm the device shows Online on the website.',
  ]
}

export function packageReadme({ device, profile, room, settings, wifiSsid }) {
  const steps = arduinoSteps(profile.espModel)
  return [
    `ACLS firmware for ${device.name} (${device.deviceId})`,
    `Room: ${room?.displayName ?? 'unassigned'}   Profile: ${profile.code} v${profile.version}${profile.verified ? '' : '   ** UNVERIFIED: bench test only **'}`,
    `Firmware ${settings.firmwareVersion}, generated ${new Date().toISOString()}`,
    '',
    'config.h contains this device\'s secret and the WiFi password. Keep it private and delete it after uploading.',
    '',
    'Upload with Arduino IDE:',
    ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    '',
    'Expected Serial Monitor output:',
    ...expectedBootLog({ profile, deviceId: device.deviceId, wifiSsid, settings, channels: profile.channels }).split('\n').map((l) => `  ${l}`),
    '',
    'If "ERROR: config.h is for acls-xxxxxx but this board is acls-yyyyyy": this file was generated for another board.',
    'If "MQTT: failed (state 5)": the credentials are wrong or were re-issued; generate the firmware again.',
    '',
  ].join('\n')
}
