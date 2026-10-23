# ACLS backend: Automatic Classroom Lighting System

REST API, live updates (Socket.IO), MQTT and the firmware generator for the ACLS website.
The website itself is in [ALS-frontend](https://github.com/omg0014/ALS-frontend).

It runs in two ways, with the same code:

| | School PC | Cloud (this guide) |
|---|---|---|
| Server | `npm start` on a PC in the school | [Render](https://render.com) |
| Database | MongoDB on that PC | [MongoDB Atlas](https://www.mongodb.com/atlas) |
| MQTT (the boards) | built into the server, port 1883 | [HiveMQ Cloud](https://www.hivemq.com/products/mqtt-cloud-broker/), encrypted (TLS, port 8883) |
| Website | served by the same server | [Vercel](https://vercel.com) |
| Lights work without internet | yes | no |

On the school PC the MQTT broker is built in. In the cloud an admin enters an MQTT broker on the website (**Settings → MQTT broker**); setting `MQTT_URL` and the other `MQTT_…` variables on the server instead also works.

## What's in here

```
src/
  server.js        starts everything
  app.js           the web API (/api/...) and /ota (board downloads)
  config.js        settings read from the environment (see .env.example)
  routes/          one file per part of the API
  services/        MQTT (broker.js), commands, live updates, firmware builds
  models/          MongoDB collections
  lib/             login, firmware generator (config.h), hardware rules
  scripts/         toolchain install, backup, password reset, device simulator, broker:ca
firmware/          the ESP32 / NodeMCU program every board runs (config.h is generated per board)
test/              end-to-end test (npm test)
render.yaml        Render blueprint
```

## Deploy to the cloud

### 1. MongoDB Atlas (free M0)
1. Create a cluster and a database user.
2. **Network Access → Add IP Address → `0.0.0.0/0`.** Render's free plan has no fixed IP.
3. Copy the connection string and add the database name `acls`:
   `mongodb+srv://USER:PASSWORD@cluster0.xxxxx.mongodb.net/acls?appName=acls`

### 2. An MQTT broker
Any MQTT broker that is reachable from the internet with a username and password works: HiveMQ Cloud, EMQX Cloud, flespi, or your own.
1. Create the broker and note its address, e.g. `abc123.s1.eu.hivemq.cloud` (port **8883**, TLS).
2. Create **two logins**, both allowed to publish and subscribe:
   - one for the server (e.g. `acls-server`);
   - one shared by all boards (e.g. `acls-devices`).
3. Optional: the broker's root certificate, so boards check they talk to the real broker (run on any PC with this repo):
   ```
   npm install
   npm run broker:ca -- mqtts://abc123.s1.eu.hivemq.cloud:8883
   ```
   Copy everything it prints, from `-----BEGIN CERTIFICATE-----` to `-----END CERTIFICATE-----`.

### 3. Render (free web service)
1. **New → Blueprint** → choose this repo. `render.yaml` sets everything up.
2. Fill in the values it asks for:

| Variable | Value |
|---|---|
| `MONGO_URL` | the Atlas string from step 1 |
| `ADMIN_PASSWORD` | password for the first `admin` login (only used on the very first start) |
| `CORS_ORIGIN` | the Vercel website address, e.g. `https://als-frontend.vercel.app` |

3. After the first deploy, open `https://<your-service>.onrender.com/api/health`. It should show `{"ok":true,"db":true}`.
4. Log in to the website as `admin` → **Settings → MQTT broker → Enter the MQTT broker**:
   - fill in the address, port 8883, both logins and the certificate (optional);
   - click **Test connection**, then **Save and connect**.
   The passwords are stored encrypted (with `JWT_SECRET`) and are never shown again.

### 4. Keep it awake
Render's free plan sleeps after 15 minutes without visitors. While it sleeps, switching and power-cut restore don't run.
Create a free job on [cron-job.org](https://cron-job.org) (or UptimeRobot) that opens
`https://<your-service>.onrender.com/api/health` **every 10 minutes**. One service running all month fits in the free 750 hours.

### 5. The website on Vercel
See [ALS-frontend](https://github.com/omg0014/ALS-frontend). Put this server's address in its `vercel.json` and `VITE_BACKEND_URL`.

### 6. The boards
On the website: **Add a device**.
1. Connect the board by USB in Chrome (or type its chip ID).
2. Pick a **template** (e.g. *ESP-12E + 30 A 1-ch · 1 AC*), or set the room's lines with + / −.
   **Save these answers as a template** to reuse them for the next classroom.
3. Type the classroom WiFi.
4. Do the wiring that's shown.
5. **Yes, download the code.** The page shows the Arduino IDE upload steps, and the board appears **online** once it runs.

Boards need firmware **1.2.0 or newer** for the encrypted broker.

## Limits on the free cloud plan
- **No firmware building on Render free.** The build tools are about 2 GB, and compiling needs more memory and CPU than 512 MB / 0.1 CPU.
  - The website therefore offers firmware as a zip for Arduino IDE. "Upload to board" from the browser and "Update over WiFi" need a server with the tools installed.
  - That can be the school-PC setup, or a bigger plan with the build command `npm ci --omit=dev && npm run toolchain:install`.
- **Needs the internet.** If the school internet is down, the website can't reach the boards.
- **Shared board login.** All boards use one HiveMQ credential, so a board's password can't be withdrawn on its own. Retiring a board removes it from the website.

## Run it locally

```
npm install
cp .env.example .env        # edit MONGO_URL etc.
npm run toolchain:install   # optional: firmware building (about 2 GB, once)
npm start                   # http://localhost:4000
npm test                    # end-to-end test against a running server (use a test database)
npm run simulate -- --id acls-a1b2c3 --secret <MQTT_PASSWORD from config.h>   # a fake board
```

Environment variables are explained in [.env.example](.env.example).
