#!/usr/bin/env bash
# One-command setup of ACLS on an Ubuntu 22.04/24.04 server with a public IP (e.g. DigitalOcean).
# Installs Node, MongoDB, the backend + website, HTTPS (Caddy, free certificate), the built-in MQTT
# broker over TLS on port 8883, the firmware build tools, a firewall, auto-start and nightly backups.
# Safe to run again: it updates the code and keeps the settings, database and certificates.
#
#   sudo bash install-server.sh                      (website at https://<ip-with-dashes>.sslip.io)
#   sudo DOMAIN=lights.myschool.in bash install-server.sh   (your own name, pointing to this server)
#   sudo MONGO_URL='mongodb+srv://…' bash …           (use MongoDB Atlas instead of a local database)
set -euo pipefail

APP=/opt/acls
REPO_BACKEND=${REPO_BACKEND:-https://github.com/omg0014/ALS-backend.git}
REPO_FRONTEND=${REPO_FRONTEND:-https://github.com/omg0014/ALS-frontend.git}
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] || { echo "This installer is for Ubuntu (found $PRETTY_NAME)"; exit 1; }
IP=$(curl -fsS -4 -m 10 https://api.ipify.org || hostname -I | awk '{print $1}')
HOST=${DOMAIN:-$(echo "$IP" | tr . -).sslip.io}
export DEBIAN_FRONTEND=noninteractive

step "System packages"
apt-get update -q
apt-get install -yq curl git ufw openssl ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https unzip

# ESP32 firmware builds need memory: add swap on small servers
MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$MEM_MB" -lt 4000 ] && ! swapon --show | grep -q /swapfile; then
  step "Swap (2 GB, this server has ${MEM_MB} MB RAM)"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

step "Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -yq nodejs
fi
node --version

if [ -z "${MONGO_URL:-}" ]; then
  step "MongoDB 8 (on this server)"
  if ! command -v mongod >/dev/null; then
    curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
    echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
    apt-get update -q
    apt-get install -yq mongodb-org
  fi
  systemctl enable --now mongod
  MONGO_URL=mongodb://127.0.0.1:27017/acls
fi

step "Caddy (HTTPS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -yq caddy
fi

step "App user and code"
id acls >/dev/null 2>&1 || useradd --system --home-dir "$APP" --shell /usr/sbin/nologin acls
mkdir -p "$APP"
for pair in "backend|$REPO_BACKEND" "frontend|$REPO_FRONTEND"; do
  dir=${pair%%|*}; repo=${pair#*|}
  if [ -d "$APP/$dir/.git" ]; then sudo -u acls -H git -C "$APP/$dir" pull --ff-only; else git clone --depth 1 "$repo" "$APP/$dir"; fi
done
chown -R acls:acls "$APP"

step "Website (build)"
sudo -u acls -H bash -c "cd $APP/frontend && npm ci --no-audit --no-fund && npm run build"

step "Backend"
sudo -u acls -H bash -c "cd $APP/backend && npm ci --omit=dev --no-audit --no-fund"

step "MQTT certificates (private root, 10 years)"
bash "$APP/backend/deploy/make-mqtt-certs.sh" "$APP/tls" "$IP" "$HOST"
chown -R acls:acls "$APP/tls"

ENV="$APP/backend/.env"
if [ ! -f "$ENV" ]; then
  step "Settings (.env)"
  ADMIN_PASSWORD=$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)
  cat > "$ENV" <<EOT
# Made by deploy/install-server.sh. See .env.example for every option.
PORT=4000
MONGO_URL=$MONGO_URL
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASSWORD=$ADMIN_PASSWORD
COOKIE_SECURE=true
TRUST_PROXY=1
PUBLIC_URL=https://$HOST
CORS_ORIGIN=https://$HOST
WEB_DIST=$APP/frontend/dist
# Boards connect here: the built-in broker, encrypted. Plain port 1883 stays closed in the firewall.
BROKER_PUBLIC_HOST=$IP
MQTT_PORT=1883
MQTT_TLS_PORT=8883
MQTT_TLS_CERT=$APP/tls/broker.pem
MQTT_TLS_KEY=$APP/tls/broker.key
MQTT_DEVICE_CA=$APP/tls/ca.pem
EOT
  chown acls:acls "$ENV"
  chmod 600 "$ENV"
  echo "$ADMIN_PASSWORD" > /root/acls-admin-password.txt
  chmod 600 /root/acls-admin-password.txt
fi

step "Firmware build tools (about 2 GB, first time takes several minutes)"
sudo -u acls -H bash -c "cd $APP/backend && npm run toolchain:install" || echo "!! Firmware tools failed to install: the website still works; run 'sudo -u acls -H bash -c \"cd $APP/backend && npm run toolchain:install\"' again later"

step "Auto-start (systemd)"
cat > /etc/systemd/system/acls.service <<EOT
[Unit]
Description=ACLS classroom lighting (website, API, MQTT broker)
After=network-online.target mongod.service
Wants=network-online.target

[Service]
User=acls
WorkingDirectory=$APP/backend
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOT
systemctl daemon-reload
systemctl enable acls
systemctl restart acls

step "HTTPS for $HOST"
cat > /etc/caddy/Caddyfile <<EOT
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:4000
}
EOT
systemctl enable caddy
systemctl reload caddy || systemctl restart caddy

step "Firewall: SSH, web (80/443), encrypted MQTT (8883)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 8883/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | sed -n '1,12p'

step "Nightly backup (02:30, kept 14 days)"
mkdir -p /var/backups/acls
if [[ "$MONGO_URL" == mongodb://127.0.0.1* ]]; then
  cat > /etc/cron.d/acls-backup <<'EOT'
30 2 * * * root mongodump --quiet --db acls --gzip --archive=/var/backups/acls/acls-$(date +\%F).gz && find /var/backups/acls -name 'acls-*.gz' -mtime +14 -delete
EOT
fi

step "Checking"
for i in $(seq 1 30); do curl -fsS -m 3 http://127.0.0.1:4000/api/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -m 5 http://127.0.0.1:4000/api/health && echo || echo "!! the app is not answering yet: journalctl -u acls -n 50"
systemctl is-active acls caddy | tr '\n' ' ' || true; echo

printf '\n\033[1mDone.\033[0m\n'
echo "  Website:   https://$HOST   (HTTPS certificate can take a minute the first time)"
[ -f /root/acls-admin-password.txt ] && echo "  Login:     admin / $(cat /root/acls-admin-password.txt)   (change it after the first login)"
echo "  Boards:    connect to $IP:8883 (encrypted, each board has its own login)"
echo "  Logs:      journalctl -u acls -f"
echo "  Update:    sudo bash $APP/backend/deploy/install-server.sh   (same command)"
