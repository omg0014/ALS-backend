#!/usr/bin/env bash
# Certificates for the built-in MQTT broker over TLS (port 8883), made once on the server.
# A private root certificate (CA) signs the broker's certificate; every board gets the root built into
# its firmware, so it only talks to this server. Valid 10 years: nothing to renew.
#
#   deploy/make-mqtt-certs.sh <folder> <server IP or name> [more names…]
set -euo pipefail
DIR="$1"; shift
[ $# -ge 1 ] || { echo "usage: $0 <folder> <server IP or name> [more names…]"; exit 1; }
mkdir -p "$DIR"; cd "$DIR"
if [ -f broker.pem ]; then echo "certificates already in $DIR (delete them to make new ones)"; exit 0; fi

SAN=""
for n in "$@"; do
  # IP addresses go in both forms: some TLS libraries on the boards compare the text only
  if [[ "$n" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SAN+="IP:$n,DNS:$n,"; else SAN+="DNS:$n,"; fi
done
SAN="${SAN%,}"

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 3650 -subj "/CN=ACLS MQTT root" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout broker.key -out broker.csr -subj "/CN=$1" 2>/dev/null
printf "subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n" "$SAN" > broker.ext
openssl x509 -req -in broker.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out broker.pem -days 3650 -extfile broker.ext 2>/dev/null
rm -f broker.csr broker.ext ca.srl
chmod 600 ca.key broker.key
openssl verify -CAfile ca.pem broker.pem >/dev/null && echo "made $DIR/ca.pem + broker.pem for: $*"
