// Prints the root certificate of the MQTT broker in MQTT_URL (or the address given), ready to paste
// into MQTT_DEVICE_CA. The boards use it to make sure they talk to the real broker.
//
//   npm run broker:ca                       (uses MQTT_URL from .env)
//   npm run broker:ca -- mqtts://xxxx.s1.eu.hivemq.cloud:8883
import tls from 'node:tls'
import { config } from '../config.js'

const url = new URL(process.argv[2] || config.externalMqtt?.url || '')
if (url.protocol !== 'mqtts:') {
  console.error('Give the broker as mqtts://host:8883 (or set MQTT_URL in .env)')
  process.exit(1)
}
const socket = tls.connect({ host: url.hostname, port: Number(url.port || 8883), servername: url.hostname }, () => {
  // Walk up the chain the server sent, completed from Node's trusted roots, to the self-signed root
  let cert = socket.getPeerCertificate(true)
  while (cert.issuerCertificate && cert.issuerCertificate !== cert && cert.issuerCertificate.fingerprint256 !== cert.fingerprint256) cert = cert.issuerCertificate
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`
  console.error(`Root certificate of ${url.hostname}: ${cert.subject.CN || cert.subject.O} (valid until ${cert.valid_to})\n`)
  console.log(pem)
  socket.end()
})
socket.on('error', (err) => {
  console.error(`Could not connect to ${url.host}: ${err.message}`)
  process.exit(1)
})
