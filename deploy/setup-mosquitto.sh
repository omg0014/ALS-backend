#!/usr/bin/env bash
# MQTT broker only (Mosquitto) for ACLS, on any Ubuntu server with a public IP. Nothing else on the
# server is touched: one package, one config file, one folder (/etc/mosquitto/acls).
#   - port 8883 only, encrypted (TLS) with a private root certificate valid 10 years
#   - two logins: acls-server (the website) and acls-devices (every board)
#   - each board (client ID = its device ID) may use only acls/v1/<its ID>/…
#   - last ON/OFF states are kept (retained) across broker restarts
# Safe to run again: keeps the certificates and passwords. At the end it prints the values for
# the website's Settings → MQTT broker.
#
#   sudo bash setup-mosquitto.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

D=/etc/mosquitto/acls
IP=${IP:-$(curl -fsS -4 -m 10 https://api.ipify.org || hostname -I | awk '{print $1}')}
if ss -tln | grep -q ':8883 ' && ! systemctl is-active --quiet mosquitto; then
  echo "Port 8883 is already used by another program: stopping here, nothing changed."
  exit 1
fi

echo "== Mosquitto"
if ! command -v mosquitto >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -yq mosquitto
fi
mosquitto -h 2>&1 | head -1 || true  # "-h" exits with code 3 even when all is well
mkdir -p "$D"

echo "== Certificate for $IP (kept if it exists)"
if [ ! -f "$D/broker.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$D/ca.key" -out "$D/ca.pem" -days 3650 -subj "/CN=ACLS MQTT root" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -keyout "$D/broker.key" -out "$D/broker.csr" -subj "/CN=$IP" 2>/dev/null
  # The IP in both forms: some TLS libraries on the boards compare the text only
  printf "subjectAltName=IP:%s,DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$IP" "$IP" > "$D/broker.ext"
  openssl x509 -req -in "$D/broker.csr" -CA "$D/ca.pem" -CAkey "$D/ca.key" -CAcreateserial -out "$D/broker.pem" -days 3650 -extfile "$D/broker.ext" 2>/dev/null
  rm -f "$D/broker.csr" "$D/broker.ext" "$D/ca.srl"
fi

echo "== Logins (kept if they exist)"
if [ ! -f "$D/passwd" ]; then
  SERVER_PW=$(openssl rand -hex 12)
  DEVICE_PW=$(openssl rand -hex 12)
  mosquitto_passwd -c -b "$D/passwd" acls-server "$SERVER_PW"
  mosquitto_passwd -b "$D/passwd" acls-devices "$DEVICE_PW"
  printf 'Server login: acls-server / %s\nBoard login:  acls-devices / %s\n' "$SERVER_PW" "$DEVICE_PW" > /root/acls-mqtt-logins.txt
  chmod 600 /root/acls-mqtt-logins.txt
fi

cat > "$D/acl" <<'EOT'
# The website may use every ACLS topic
user acls-server
topic readwrite acls/v1/#

# Every client only its own topics: a board's client ID is its device ID (acls-xxxxxx)
pattern readwrite acls/v1/%c/#
EOT

cat > /etc/mosquitto/conf.d/acls.conf <<EOT
# ACLS: encrypted MQTT on 8883 only, logins required (made by setup-mosquitto.sh)
listener 8883
certfile $D/broker.pem
keyfile $D/broker.key
allow_anonymous false
password_file $D/passwd
acl_file $D/acl
EOT

chown -R mosquitto:mosquitto "$D"
chmod 700 "$D"
chmod 600 "$D"/*
chmod 644 "$D/ca.pem" "$D/broker.pem"
chown root:root "$D/ca.key"

echo "== Start"
systemctl enable mosquitto >/dev/null 2>&1
systemctl restart mosquitto
sleep 1
systemctl is-active mosquitto
ss -tln | grep ':8883 ' >/dev/null && echo "listening on 8883" || { echo "!! not listening: journalctl -u mosquitto -n 30"; exit 1; }
if ufw status 2>/dev/null | grep -q "Status: active"; then ufw allow 8883/tcp; fi

echo
echo "================ Enter these on the website: Settings → MQTT broker ================"
echo "Broker address:  $IP"
echo "Port:            8883   (Encrypted connection: ticked)"
cat /root/acls-mqtt-logins.txt
echo "Root certificate (copy everything from BEGIN to END, into 'Root certificate'):"
cat "$D/ca.pem"
echo "======================================================================================"
echo "Keep the passwords private. They are also in /root/acls-mqtt-logins.txt on this server."
echo "To remove everything later:  apt-get remove -y mosquitto && rm -rf $D /etc/mosquitto/conf.d/acls.conf /root/acls-mqtt-logins.txt"
