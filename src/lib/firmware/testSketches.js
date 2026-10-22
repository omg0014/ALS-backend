import { pinLabel } from '../hardwareRules.js'
import { TOOLCHAIN } from './toolchain.js'

const inLabel = (profile, index) => (profile.channels === 1 ? 'IN' : `IN${index}`)

// ---- Test sketches (C3). New sketches written for ACLS, not copied from the verified set. ----

function cStr(s) {
  return `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '')}"`
}

function pinBlock(profile, channels) {
  const sorted = [...channels].sort((a, b) => a.index - b.index)
  const labels = sorted.map((c) => `${inLabel(profile, c.index)} (${pinLabel(profile.espModel, c.gpio)}/GPIO${c.gpio})`)
  const on = profile.trigger
  const off = on === 'HIGH' ? 'LOW' : 'HIGH'
  return `// Relay pins and trigger level from hardware profile ${profile.code} v${profile.version}. Do not change them here.
const uint8_t RELAY_PINS[] = {${sorted.map((c) => c.gpio).join(', ')}};
const char* RELAY_LABELS[] = {${labels.map((l) => `"${l}"`).join(', ')}};
const int RELAY_COUNT = ${sorted.length};
#define RELAY_ON ${on}    // active ${on} module${profile.triggerNote ? `: ${profile.triggerNote}` : ''}
#define RELAY_OFF ${off}

// Write the OFF level BEFORE pinMode(OUTPUT), then again after, so no relay clicks ON at boot.
void relaysOffSafely() {
  for (int i = 0; i < RELAY_COUNT; i++) {
    digitalWrite(RELAY_PINS[i], RELAY_OFF);
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], RELAY_OFF);
  }
}`
}

function header(title, profile, see) {
  return `// ACLS test sketch: ${title}
// Profile ${profile.code} v${profile.version}: ${profile.espBoard} + ${profile.relayModule}
// NEW sketch written for ACLS, not from the verified set: check it on the bench before relying on it.
//
// What you should see:
${see.map((l) => `//   - ${l}`).join('\n')}
//
// Board: ${TOOLCHAIN[profile.espModel].boardName}, upload speed 115200, Serial Monitor 115200.
`
}

export function testSketches({ profile, channels, wifiSsid = '', wifiPassword = '' }) {
  wifiSsid = String(wifiSsid).replace(/[\r\n]/g, '') // also used inside // comments
  const block = pinBlock(profile, channels)
  const ledPin = profile.statusLed?.gpio
  const multi = channels.length > 1

  const pinTest = `${header('relay pin test (each relay in turn)', profile, [
    'Serial Monitor prints each channel as it switches, e.g. "IN1 (D1/GPIO5) ON".',
    'Each relay clicks ON for 2 s, then OFF. Its indicator LED is lit while ON.',
    'With a continuity meter on the relay outputs: COM-NO closes (beeps) while ON and opens when OFF.',
    ...(multi ? ['Then ALL channels ON together for 5 s. The board must NOT reboot; if it does, the 5V supply is too weak.'] : []),
    'No relay clicks at power-up. The uptime line keeps increasing (if it drops to 0, the board rebooted).',
  ])}
${block}

int roundNo = 0;

void setup() {
  relaysOffSafely();            // first thing: relays stay OFF while the board boots
  Serial.begin(115200);         // same speed as the Serial Monitor
  delay(300);
  Serial.println();
  Serial.println("ACLS pin test, profile ${profile.code}");
}

void loop() {
  roundNo++;
  Serial.printf("--- round %d ---\\n", roundNo);
  for (int i = 0; i < RELAY_COUNT; i++) {
    Serial.printf("%s ON\\n", RELAY_LABELS[i]);
    digitalWrite(RELAY_PINS[i], RELAY_ON);    // relay i clicks ON: COM-NO closes
    delay(2000);
    digitalWrite(RELAY_PINS[i], RELAY_OFF);   // relay i clicks OFF: COM-NO opens
    Serial.printf("%s OFF\\n", RELAY_LABELS[i]);
    delay(1000);
  }
${
  multi
    ? `  Serial.println("ALL ON for 5 s (the board must not reboot)");
  for (int i = 0; i < RELAY_COUNT; i++) digitalWrite(RELAY_PINS[i], RELAY_ON);   // worst case coil current
  delay(5000);
  for (int i = 0; i < RELAY_COUNT; i++) digitalWrite(RELAY_PINS[i], RELAY_OFF);
  Serial.println("ALL OFF");
`
    : ''
}  Serial.printf("uptime %lu s\\n", millis() / 1000);   // keeps growing unless the board rebooted
  delay(3000);
}
`

  const ledChaser = `${header('LED chaser (fast pin check)', profile, [
    'The relay channels switch one after another every 300 ms, like a running light.',
    'With the relay module connected: its indicator LEDs light in turn and the relays click quickly. Keep this test short.',
    `With bare LEDs (+ resistor) from each pin to GND instead of the module: on an active-${profile.trigger} profile the pattern ${profile.trigger === 'LOW' ? 'looks inverted (all lit except one); that is expected' : 'shows one LED lit at a time'}.`,
    ...(ledPin != null ? [`The onboard LED (GPIO${ledPin}) blinks once per full round.`] : []),
    'Serial Monitor prints "round N" after each full chase.',
  ])}
${block}
${ledPin != null ? `\n#define STATUS_LED ${ledPin}   // onboard LED, active ${profile.statusLed.activeLow ? 'LOW' : 'HIGH'}, status light only\n` : ''}
int roundNo = 0;

void setup() {
  relaysOffSafely();
${ledPin != null ? `  pinMode(STATUS_LED, OUTPUT);\n  digitalWrite(STATUS_LED, ${profile.statusLed.activeLow ? 'HIGH' : 'LOW'});   // LED off\n` : ''}  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("ACLS LED chaser, profile ${profile.code}");
}

void loop() {
  for (int i = 0; i < RELAY_COUNT; i++) {
    digitalWrite(RELAY_PINS[i], RELAY_ON);    // this channel on
    delay(300);
    digitalWrite(RELAY_PINS[i], RELAY_OFF);   // and off again before the next one
  }
${ledPin != null ? `  digitalWrite(STATUS_LED, ${profile.statusLed.activeLow ? 'LOW' : 'HIGH'});    // blink the onboard LED once per round\n  delay(100);\n  digitalWrite(STATUS_LED, ${profile.statusLed.activeLow ? 'HIGH' : 'LOW'});\n` : ''}  roundNo++;
  Serial.printf("round %d\\n", roundNo);
  delay(500);
}
`

  const wifiTest = `${header('single-relay WiFi test', profile, [
    'Serial Monitor lists the WiFi networks it can hear, with signal strength (dBm).',
    `It joins "${wifiSsid || 'your WiFi'}" and prints its IP address and RSSI. Above -75 dBm is fine for installation.`,
    'From a phone on the same WiFi, open http://<that IP>/ and tap ON / OFF.',
    `${inLabel(profile, channels[0]?.index ?? 1)} clicks ON and OFF; the page shows the state. No board reboot when the relay switches.`,
    'If WiFi does not connect within 20 s the board restarts and tries again.',
  ])}
#ifdef ESP8266
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
ESP8266WebServer server(80);
#else
#include <WiFi.h>
#include <WebServer.h>
WebServer server(80);
#endif

// WiFi near this classroom (entered on the website). Used only for this test.
const char* WIFI_NAME = ${cStr(wifiSsid)};
const char* WIFI_PASSWORD = ${cStr(wifiPassword)};

${block}

bool relayOn = false;

void sendPage() {
  String html = "<!doctype html><meta name=viewport content='width=device-width'>"
                "<h2>ACLS WiFi test</h2><p>" + String(RELAY_LABELS[0]) + " is <b>" + (relayOn ? "ON" : "OFF") + "</b></p>"
                "<p><a href='/on'><button style='font-size:24px'>ON</button></a> "
                "<a href='/off'><button style='font-size:24px'>OFF</button></a></p>"
                "<p>RSSI " + String(WiFi.RSSI()) + " dBm, uptime " + String(millis() / 1000) + " s</p>";
  server.send(200, "text/html", html);
}

void setRelay(bool on) {
  relayOn = on;
  digitalWrite(RELAY_PINS[0], on ? RELAY_ON : RELAY_OFF);   // only the first channel is used here
  Serial.printf("%s %s\\n", RELAY_LABELS[0], on ? "ON" : "OFF");
}

void setup() {
  relaysOffSafely();
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("ACLS WiFi test, profile ${profile.code}");

  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();                      // what can this board hear here?
  Serial.printf("%d networks found:\\n", n);
  for (int i = 0; i < n; i++) Serial.printf("  %-32s %d dBm\\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i));

  WiFi.begin(WIFI_NAME, WIFI_PASSWORD);
  Serial.printf("Connecting to \\"%s\\"", WIFI_NAME);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print('.');
    if (++tries > 40) ESP.restart();               // 20 s without WiFi: restart and try again
  }
  Serial.printf("\\nConnected. Open http://%s/ on a phone on the same WiFi. RSSI %d dBm\\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());

  server.on("/", sendPage);
  server.on("/on", []() { setRelay(true); sendPage(); });
  server.on("/off", []() { setRelay(false); sendPage(); });
  server.begin();
}

void loop() {
  server.handleClient();
}
`

  return [
    { kind: 'pin_test', title: 'Relay pin test', folder: 'acls_pin_test', content: pinTest },
    { kind: 'led_chaser', title: 'LED chaser', folder: 'acls_led_chaser', content: ledChaser },
    { kind: 'wifi_test', title: 'Single-relay WiFi test', folder: 'acls_wifi_test', content: wifiTest },
  ].map((s) => ({ ...s, filename: `${s.folder}/${s.folder}.ino`, whatToSee: s.content.match(/^\/\/ {3}- .*$/gm).map((l) => l.slice(7)) }))
}
