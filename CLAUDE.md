# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.15), its only
runtime dependency. It reads the devices of the user's Homey Pro through its
local Web API (an API key), follows their changes through the Homey realtime
events and sends the Gladys commands back. Unofficial, not affiliated with
Athom.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/mapping.test.js          # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npm run audit                             # npm audit --omit=dev
npx github:GladysAssistant/integration-store .   # store admission checks
```

Run `format:check`, `lint`, `test` and `audit` before every commit.

## Architecture

```
index.js            SDK bootstrap only
src/handlers.js     every SDK handler -> the app (shared with the tests)
src/app.js          HomeyApp: finding Homey, connection, reads, realtime
                    events, presses, commands, transports, connection test
src/homey.js        the HTTP access: ping, devices, zones, capability sets,
                    the Bearer key, error kinds
src/realtime.js     the realtime socket: Socket.IO 2 / Engine.IO 3 over the
                    WebSocket of Node.js (handshakeClient, /api, subscribe)
src/discovery.js    mDNS scan results -> addresses to try (pure)
src/inventory.js    devices + zones -> devices with their zone (pure)
src/mapping.js      one Homey device -> features, readers, writers (pure)
src/devices.js      devices -> Gladys devices + routing tables (pure)
src/publisher.js    states within the Gladys rate limit, presses apart
src/config.js       config_schema normalized (address, key)
src/constants.js    manifest keys, API paths, limits, timings
src/i18n.js         runtime texts (en/fr)
test/fixtures/      answers shaped like a Homey Pro (2023) local API
test/helpers/       a fake Homey (app tests), a simulated Homey on 127.0.0.1
                    (HTTP + WebSocket, e2e); Gladys is the SDK's fake
```

## Rules

- **External ids are forever**: device = `homey:<Homey device id>`, feature =
  `<capability id>` (sub-capabilities included: `onoff.2`,
  `measure_temperature.outside`), and `color` for light_hue +
  light_saturation. Never change how they are built.
- The manifest keys (`test_connection`, `api_key`, `homey_address`,
  `sensor_interval`) and the saved `homey_id` are frozen: users store them.
- Value conventions: the Homey side is its capability units (dim and
  windowcoverings_set 0…1, light_temperature 0 = coldest … 1 = warmest,
  light_hue/saturation 0…1, temperatures in °C, alarm_contact true = open);
  the Gladys side the enums of `server/utils/constants.js` (copied in
  `src/mapping.js`, the SDK does not export them). Convert in the readers and
  writers.
- Button presses go through `publisher.pushEvent` (publishStates): never
  through `publishChangedStates`, which would drop a second identical press.
  A press is a realtime `capability` event of a button, or, without the
  socket, a new `lastUpdated` of it; never read at the connection.
- Never send a unit Gladys does not know: the whole device list would be
  refused.
- Container limits: 256 MB RAM, 0.5 CPU, read-only rootfs, only `/data`
  writable, bridge network (unicast to the LAN only; mDNS only through
  `gladys.scanNetwork('mdns')` and the manifest `network_discovery`).
- Gladys rate limits: 300 states/min, 300 scene events/min.
- Never log or put in a status message the API key; errors never quote
  request headers.
- Tests never touch the network: the fake Homey, or the simulated Homey on
  127.0.0.1 (`test/helpers/homeyServer.js`).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` kept in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
