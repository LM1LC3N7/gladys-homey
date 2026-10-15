# gladys-homey

[Gladys Assistant](https://gladysassistant.com) external integration bridging a
**Homey Pro**: every Homey device becomes a Gladys device of the Discovery tab,
its states follow Homey live, and Gladys controls it through Homey, over the
local Web API with an API key. Made for Homey users who move to Gladys at
their own pace, or run both side by side.
Unofficial, not affiliated with Athom.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> Work in progress (0.1, not published to the store yet): announced on the
> [Gladys forum](https://community.gladysassistant.com/t/integrations-home-assistant-les-plus-populaires-candidates-pour-des-integrations-externes-gladys/10385/178).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (HomeyApp) ⇄ src/homey.js     ⇄ Homey local Web API (HTTP)
                                   │                     ⇄ src/realtime.js  ⇄ Homey realtime (Socket.IO 2)
                                   ├─ src/discovery.js  mDNS scan results -> addresses to try (pure)
                                   ├─ src/inventory.js  devices + zones -> device list (pure)
                                   ├─ src/mapping.js    one device -> features, readers, writers (pure)
                                   ├─ src/devices.js    devices -> Gladys devices + routing tables (pure)
                                   └─ src/publisher.js  states within 300/min, sensor throttling, presses
```

- **Finding Homey**: the address typed, or none: `gladys.scanNetwork('mdns')`
  (service `_homey._tcp`, declared in the manifest), each address confirmed by
  the `X-Homey-ID` header of `GET /api/manager/system/ping`; the address and
  the id are saved in the configuration. When Homey stops answering, it is
  looked for again by its id (new DHCP address).
- **Signing in**: an API key (Homey web app, Settings → API Keys) as
  `Authorization: Bearer` on every request, and as the token of the realtime
  `handshakeClient`.
- **Inventory**: `GET /api/manager/devices/device` and
  `GET /api/manager/zones/zone`; one Gladys device per Homey device, named
  "device (zone)". External ids `ext:<selector>:homey:<device id>` and
  `…:<capability id>`.
- **Changes**: a WebSocket to `/socket.io/?EIO=3&transport=websocket`,
  `handshakeClient`, namespace `/api`, subscriptions to
  `homey:manager:devices` (devices created, updated, deleted) and
  `homey:device:<id>` (the `capability` events). The device list is read again
  every 5 minutes; without the socket, every 10 seconds (and the socket is
  tried again).
- **Commands**: `PUT /api/manager/devices/device/<id>/capability/<capability>`
  with `{ value }`; Homey's realtime echo is the feedback.
- **Mapping**: by capability (`onoff`, `dim`, `light_*`,
  `windowcoverings_*`, `target_temperature`, `thermostat_mode`, `locked`,
  `button`, `measure_*`, `meter_*`, `alarm_*`), sub-capabilities included; the
  Gladys core enums on the other side (a door contact is 0 = open in Gladys).
- **Failures**: Homey unreachable → status message and `unreachable`
  transport badges, reconnection after 5 s, doubling up to 60 s (refused key:
  every 5 minutes). A device Homey marks unavailable gets an unreachable badge
  with Homey's reason; no live updates, an orange dot.

## Reused work

Athom publishes [`homey-api`](https://www.npmjs.com/package/homey-api)
([athombv/node-homey-api](https://github.com/athombv/node-homey-api)), the
official JavaScript client of the Homey Web API, actively maintained (3.20.1
of 2026-10-06, a 4.0 alpha). It was checked first and **not used**:

- its licence is not an open-source one ("Package may be used freely with
  Homey products — Source code is proprietary to Athom B.V."), which does not
  fit an Apache-2.0 image redistributed through the Gladys store;
- it pulls `socket.io-client` 2 and `engine.io-client` 3 (63 packages,
  7.4 MB): `npm audit` reports 4 moderate advisories (parseuri ReDoS) with no
  fix short of a major downgrade, and its 4.0 alpha keeps the same
  dependencies.

The client is therefore our own: ~240 lines of HTTP (`src/homey.js`) and
~320 lines of Socket.IO 2 over the WebSocket built into Node.js
(`src/realtime.js`), no runtime dependency besides the Gladys SDK. Credits,
read as documentation, nothing copied:

- [athombv/node-homey-api](https://github.com/athombv/node-homey-api)
  (proprietary): the paths of its local API specification, the
  `SocketSession` / `SubscriptionRegistry` sequence (handshake on the root
  namespace, then `/api`, then `subscribe` per URI), the `capability` event
  fields, `createLocalAPI` (ping and `X-Homey-ID`).
- The [Homey Web API documentation](https://api.developer.homey.app) (Socket.io
  specification) and the Homey support article on API keys.
- [ifMike/homeyHASS](https://github.com/ifMike/homeyHASS) (MIT), a Home
  Assistant integration of the same local API: the `_homey._tcp` mDNS
  service, the `homey:manager:devices` events, the permissions an API key
  needs, and that the Homey Pro (Early 2019) has no API keys.

## Development

```bash
npm install
npm test                                        # node --test, no network
npm run lint && npm run format:check
npm run audit
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/homey-pro-2023/` holds the answers of a Homey Pro (2023),
shaped like the local Web API answers (the device and zone schemas of the
node-homey-api specification): 24 devices of every kind in 6 zones.
`test/helpers/fakeHomey.js` serves them to the app tests (mocked timers);
`test/helpers/homeyServer.js` is a simulated Homey on 127.0.0.1 (HTTP API and
a minimal WebSocket server speaking Socket.IO 2), against which
`test/e2e.test.js` runs the real client and socket. No real Homey has been
used yet: see TODO.md, "To check on a real Homey".

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release only.

## License

Apache-2.0. Homey is a trademark of Athom B.V.; this project is not affiliated
with Athom.
