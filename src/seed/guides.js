// Help guides (PRD C3), built from the toolchain notes and lessons learned. Guides that nobody has
// edited are refreshed from this file on start-up; once an admin edits a guide, the website version is kept.
import { TOOLCHAIN } from '../lib/firmware/index.js'

const libs = TOOLCHAIN.libraries.map((l) => `- **${l.name}** by ${l.author}, version ${l.version}`).join('\n')

export const GUIDES = [
  // ---- Uploading (the website is the main way) ----
  {
    slug: 'upload-from-website',
    title: 'Upload firmware from the website (USB)',
    category: 'upload',
    order: 1,
    markdown: `The website prepares the firmware and uploads it to the board itself, like the Arduino IDE but with nothing to install on your laptop.

**Where:** on the **server PC**, open **http://localhost:4000** in **Chrome or Edge**. Browsers only allow USB on the computer itself.

1. **Devices → Add a device** (new board) or open a device → **Upload firmware**.
2. Go through the steps. On the last one press **prepare the firmware** (about half a minute).
3. Unplug the board's 5 V power supply, then connect the board to the PC with a USB **data** cable.
4. Click **Connect board** and choose the port named *usbserial*, *wchusbserial*, CH340 or CP210x.
5. The website checks it is the right board, then click **Upload**. Wait for 100 %.
6. The board's messages appear on the page. The last lines should be:

\`\`\`
WiFi: connected, IP 192.168.x.x, RSSI -60 dBm
MQTT: connected, waiting for commands
\`\`\`

7. The page shows **connected** by itself. Unplug USB and connect the 5 V supply.

> Never connect the laptop's USB and the 5 V power supply at the same time.

Problems? See *Stuck at "Connecting"* and *Port not found*.`,
  },
  {
    slug: 'update-over-wifi',
    title: 'Update a device over WiFi',
    category: 'upload',
    order: 2,
    markdown: `Installed devices can get new firmware without opening the box.

1. Open the device (**Devices** → the device) → **Update over WiFi**.
2. Enter the WiFi password of that classroom and press **Start update**.
3. The page shows each step: preparing → sent → downloading → installing → restarted.

- The device restarts at the end. Its lights switch off for a few seconds and then come back as they were.
- If anything fails, the device keeps its old firmware and keeps working.
- Needs firmware **1.1.0 or newer** on the device. A brand-new board gets its first firmware over USB.`,
  },
  {
    slug: 'code-editor',
    title: 'Code editor: your own programs',
    category: 'upload',
    order: 3,
    markdown: `**Code editor** (admins) is the website's own Arduino IDE for your own programs and experiments.

1. Pick the **board** (NodeMCU or ESP32) and write or paste your program, or start from an **example**.
2. **Check** compiles it on the server. Errors are listed with their line number: click one to jump to it.
3. **Upload** compiles it and uploads it over USB (on the server PC, Chrome or Edge), then shows the board's messages.
4. **Save** keeps the program in *My programs* for everyone.

> Uploading your own program **replaces the ACLS firmware** on that board: it stops working with the lighting system until you upload the ACLS firmware again (Devices → Upload firmware). For the lights themselves always use *Upload firmware*.

Available libraries: ${[...TOOLCHAIN.libraries, ...TOOLCHAIN.editorLibraries].map((l) => `${l.name} ${l.version}`).join(', ')}, plus the built-in ESP libraries (WiFi, WebServer, …).`,
  },
  {
    slug: 'upload-firmware',
    title: 'Arduino IDE (fallback): upload the ACLS firmware',
    category: 'upload',
    order: 10,
    markdown: `Use this only if uploading from the website is not possible.

1. In the firmware steps choose **Use Arduino IDE instead** and download the zip.
2. Unzip it. Open \`acls_firmware/acls_firmware.ino\`; \`config.h\` opens as a second tab. **Do not edit either file.**
3. Select the board, port and upload speed (see *Arduino IDE (fallback): board, port and speed*).
4. Click **Upload**. If it hangs at *Connecting…*, see *Stuck at "Connecting"*.
5. Open **Serial Monitor at 115200** and check the last line says \`MQTT: connected, waiting for commands\`.

> \`config.h\` contains the device password and the WiFi password. Delete the download after uploading.`,
  },
  {
    slug: 'arduino-ide-setup',
    title: 'Arduino IDE (fallback): install board cores and libraries',
    category: 'upload',
    order: 11,
    markdown: `Only needed for the Arduino IDE fallback. The website does not need any of this.

1. Install **Arduino IDE 2** from arduino.cc.
2. In **Settings → Additional boards manager URLs** add (one per line):
   - \`${TOOLCHAIN.esp32.boardUrl}\`
   - \`${TOOLCHAIN.esp8266.boardUrl}\`
3. **Boards Manager:** install **${TOOLCHAIN.esp32.core}** ${TOOLCHAIN.esp32.coreVersion} and **${TOOLCHAIN.esp8266.core}** ${TOOLCHAIN.esp8266.coreVersion}.
4. **Library Manager:** install these exact versions:
${libs}

These are the same versions the website uses, so every board is built the same way.`,
  },
  {
    slug: 'select-board-and-port',
    title: 'Arduino IDE (fallback): board, port and speed',
    category: 'upload',
    order: 12,
    markdown: `| Board | Tools → Board | Upload speed |
|---|---|---|
| ESP32 DevKit | **${TOOLCHAIN.esp32.boardName}** | **115200** (921600 fails) |
| NodeMCU v3 | **${TOOLCHAIN.esp8266.boardName}** | **115200** |

**Port:** the *usbserial* / *wchusbserial* port that appears when you plug the board in. The firmware refuses to build if \`config.h\` was made for the other board type: pick the board the error names.`,
  },

  // ---- Getting set up ----
  {
    slug: 'usb-drivers-macos',
    title: 'USB driver for the boards',
    category: 'setup',
    order: 1,
    markdown: `Both boards use a WCH USB chip: **CH340** on the NodeMCU, **CH9102** on the ESP32 DevKit.

- Recent macOS and Windows 10/11 usually recognise them by themselves.
- If no port appears when you click **Connect board**, install the **WCH CH34x** driver and, on macOS, allow it in *System Settings → Privacy & Security*. Restart if asked.`,
  },
  {
    slug: 'chip-id',
    title: "Find a board's chip ID",
    category: 'setup',
    order: 2,
    markdown: `Each board is known on the website as **acls-** plus its 6-character chip ID.

**Easiest (on the server PC):** in **Add a device**, plug the board in by USB and press **Read chip ID from USB**. It is filled in for you.

**Otherwise:** download the *Chip ID program* from the same step, upload it, and read \`ACLS device ID: acls-3fa2c1\` in the serial output.`,
  },
  {
    slug: 'wifi-per-classroom',
    title: 'WiFi for each classroom',
    category: 'setup',
    order: 3,
    markdown: `Each floor or classroom area has its own WiFi. The device steps ask for the WiFi name and password and build them into that device's firmware.

- The website remembers the WiFi **name** per room, never the password.
- To change the WiFi of an installed device: **Update over WiFi** (while it can still connect) or upload again over USB.
- Check the signal at the box with the **WiFi test** program or the **WiFi scan** example: above about −75 dBm is fine.`,
  },
  {
    slug: 'bench-test',
    title: 'Desk test before installation',
    category: 'setup',
    order: 4,
    markdown: `On the desk, before the box goes to the classroom:

1. **Rooms → the room → Installation steps → Test programs → Upload by USB** the *Relay pin test*.
2. Check: **each relay clicks**, **COM-NO closes when ON** (continuity meter), and **no restart when all relays switch** together.
3. Check the relay board setting (red 30 A: jumper on **H**; blue 4-relay: JD-VCC jumper).
4. Tick the checklist and **Save desk test**.

A hardware type that is **not yet tested** may only be used on the desk. After its desk test passes, an admin marks it as tested on *Hardware types*.`,
  },

  // ---- When something goes wrong ----
  {
    slug: 'flash-boot-rst',
    title: 'Stuck at "Connecting": the FLASH / BOOT + RST method',
    category: 'troubleshooting',
    order: 1,
    markdown: `If **Connect board** (or Arduino IDE's *Connecting……*) fails, the board did not enter upload mode.

1. Click **Connect board** again.
2. While it is connecting, **hold FLASH** (NodeMCU) or **BOOT** (ESP32).
3. While holding it, **tap RST** (EN) once.
4. Release FLASH/BOOT when the upload starts.

Also check: the cable carries data (not a charge-only cable), and nothing else (Arduino IDE's Serial Monitor) has the port open.`,
  },
  {
    slug: 'port-not-found',
    title: 'Port not found',
    category: 'troubleshooting',
    order: 2,
    markdown: `- Use **Chrome or Edge** on the **server PC** at **http://localhost:4000**: other browsers and other computers cannot use USB from the website.
- Try another USB cable: many cables are charge-only.
- Plug directly into the PC, not through a hub.
- Install the USB driver (see *USB driver for the boards*).
- Close Arduino IDE or anything else that may have the port open.`,
  },
  {
    slug: 'relay-never-releases',
    title: 'Relay turns ON but never OFF',
    category: 'troubleshooting',
    order: 3,
    markdown: `Cause: 3.3V ESP logic driving a 5V relay board. Active-LOW boards may not fully release at 3.3V; the indicator LED glows dimly and the relay stays ON.

| Module | Fix (verified where marked) |
|---|---|
| **Red 1-ch 30A** | Set the H/L jumper to **H** and use active HIGH (profile P2/P5). In L mode at 3.3V the relay never releases (**verified**). |
| **Blue 4-ch 10A** | Remove the **JD-VCC jumper**: module VCC to **3V3**, JD-VCC to **5V**, GND common. |
| **Blue 2-ch 7A** | Unknown: test on the bench before deployment (profile P3 is unverified). |`,
  },
  {
    slug: 'board-reboots',
    title: 'Board restarts when a relay clicks',
    category: 'troubleshooting',
    order: 4,
    markdown: `Cause: not enough power. Laptop/hub USB cannot power NodeMCU WiFi plus a 30A relay coil (~180 mA): the board brown-outs and restarts.

- Field units need a proper 5V supply: **HLK-5M05** (5V 1A) for one 30A relay or a 10A multi-channel board; **HLK-10M05** (5V 2A) for two 30A relays.
- Relay VCC from the 5V rail, **never** from the ESP 3V3 pin.
- ESP and relay grounds always common.
- **Never connect laptop USB and the field 5V supply at the same time.**

The device page shows restarts under *Status* and the Home page lists *Restarting often*.`,
  },
  {
    slug: 'female-jumper-screw-terminal',
    title: 'Female jumper ends in screw terminals',
    category: 'troubleshooting',
    order: 5,
    markdown: `Never clamp a **female** jumper end in a screw terminal: it makes a loose, intermittent contact. Put a **header pin** in first (or use a male end / ferrule), then tighten the screw on the pin.`,
  },
  {
    slug: 'device-not-online',
    title: 'Uploaded but the device is not connected',
    category: 'troubleshooting',
    order: 6,
    markdown: `Read the board's messages (shown on the page after a website upload, or the Serial Monitor at 115200):

| Message | Meaning |
|---|---|
| \`WiFi: not connected after 20 s, restarting\` | Wrong WiFi name/password, or out of range. Upload again with the right WiFi for this classroom. |
| \`MQTT: failed (state 5)\` or \`(state 4)\` | The device's login was renewed after this upload. Upload the firmware again. |
| \`MQTT: failed (state -2)\` | Cannot reach the server: check that the device WiFi can reach this PC, and that the address shown in the upload wizard is this PC's current network address. |
| \`ERROR: config.h is for acls-… but this board is acls-…\` | The firmware was made for another board. Add this board (or use *Replace a broken board*) and upload again. |`,
  },
]
