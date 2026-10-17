# TODO — Homey Pro bridge v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`,
  `npm run audit`, then update README, `docs/en.md`, `docs/fr.md`,
  `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only (before, the store would list an empty integration).
- No forum topic of its own, ever, and no forum post from a module session:
  the batch claimed in /t/10385 (post #178) gets one recap message there, with
  a link to each repo, once the ten are published.

## Status

- [x] **Milestone 1 — core** (2026-10-15): own client of the Homey local Web
      API (HTTP + Socket.IO 2 realtime), API key, Homey found by mDNS
      (`_homey._tcp`) and found again by its id after an address change,
      inventory (devices + zones, the zone in the names), mapping of the light,
      switch, cover, thermostat, lock, button, measure, meter and alarm
      capabilities (sub-capabilities included), live updates with a resync
      every 5 minutes (every 10 s without the socket), buttons as events,
      commands, transport badges (availability, live updates), connection
      test, manifest, docs en/fr. 77 tests, among them an end-to-end run of
      the real client and socket against a simulated Homey on 127.0.0.1. No
      real Homey yet.
- [ ] **Milestone 2 — a real Homey Pro**: run it on a Homey Pro (2023) (a
      tester from the forum), collect real `devices` / `zones` answers and
      realtime events as fixtures, check everything listed in "To check on a
      real Homey" below; then a Homey Pro mini and a Self-Hosted Server.
- [ ] **Milestone 3 — more capabilities**: Flows as a scene action ("Run a
      Homey Flow", `homey.flow.start`), speakers and media (`speaker_*`,
      `volume_*`), fans and air conditioners (`fan_speed`, AC modes as the
      Gladys air-conditioning category), `homealarm_state`, `garagedoor_closed`,
      `windowcoverings_tilt_set`, `measure_pm10`, `measure_tvoc`,
      `measure_wind_*`, `measure_rain`, `measure_ultraviolet`, the exported
      energy of `meter_power.exported` (production), Logic variables.
- [ ] **Milestone 4 — first release**: cover image, Docker image build check,
      `npx github:GladysAssistant/integration-store .`, Release workflow,
      topic (the forum recap is the main session's, see Working method).

## To check on a real Homey

- The realtime protocol: handshake with an API key (token = the key, homeyId
  from the ping), the `/api` namespace, the `subscribe` acknowledgments, the
  `capability` payload (`transactionTime` a number?), and which permission
  the socket needs ("View System", per homeyHASS).
- Whether `device.update` of `homey:manager:devices` carries the whole device
  (properties and `capabilitiesObj`) or a part, and whether capability changes
  also fire it.
- Engine.IO 3 still accepted by the current Homey firmware (node-homey-api 3.20
  and 4.0 alpha still use socket.io-client 2, so it should).
- The fields of a `capabilitiesObj` entry (`title` in the Homey language,
  `setable`, `min`/`max`/`step`, `values` of the enums) on real drivers; the
  units of `measure_temperature` when Homey shows °F (assumed °C in the API).
- The `button` capability: value of the events (true?), echo of a press set
  from Gladys, buttons with `getable: false`.
- `light_temperature` drivers declaring kelvins (`max` above 1), the
  `light_mode` switch order (value then mode).
- The mDNS answer of a Homey (`_homey._tcp`, the addresses, the port) through
  the Gladys core scan, and the ping on port 80.
- A key without "View zones": the 403 and the bare names.
- `https://<ip>.homey.homeylocal.com` addresses (valid certificate, local DNS).

## Decisions

- **Guarded commands** (2026-10-17, Louis's rule): unlocking (`locked` = 0),
  and the switch, brightness, cover and button commands of the Homey classes
  (or virtual classes) `garagedoor`, `watervalve` / `sprinkler` / `faucet`,
  `homealarm` / `smokealarm` / `siren`, `lock` (both ways), or of a device with
  a `locked`, `garagedoor_closed` or `homealarm_state` capability
  (`GUARDED_CLASSES`, `GUARDED_CAPABILITIES` of src/mapping.js; the classes of
  athombv/node-homey-lib, `watervalve`, `sprinkler`, `siren` since Homey 12.0),
  are refused in `setValue` unless `allow_unlock`, `allow_garage_door_control`,
  `allow_valve_control`, `allow_alarm_control` is on (all off by default). A
  valve, siren or gate relay filed under `socket`, `relay`, `other` or
  `sensor` without those capabilities is not protected (documented). The guard
  of the mapping is kept on the writer; a device missing from the records is
  refused. The features stay writable (frozen at creation, the option can be
  turned on later); keys and external ids are unchanged. Allowed, the device
  is read (`GET /api/manager/devices/device/:id`) just before and the command
  refused on a failed read, an unavailable device or an unknown state (so
  `getable: false` is refused even when allowed). Guarded commands are
  serialized per device, the others per feature; the deadline (3.5 s, Gladys
  ack 5 s) is checked before the first request only. Refusals are bilingual,
  with the manifest labels. To check on a real Homey: the single device
  endpoint.

- **Own client, not `homey-api`** (Louis's rule: reuse maintained community
  work unless it brings debt). `homey-api` is Athom's official, actively
  maintained client (3.20.1, 2026-10-06; a 4.0 alpha), Node ≥ 22. Rejected
  because (1) its licence is proprietary ("may be used freely with Homey
  products, source code is proprietary to Athom B.V."), not compatible with an
  Apache-2.0 image redistributed by the store; (2) it depends on
  `socket.io-client` 2 / `engine.io-client` 3 (63 packages, 7.4 MB) with 4
  moderate `npm audit` advisories (parseuri ReDoS) and no fix but a major
  downgrade, the 4.0 alpha keeping the same dependencies. The API needed is
  four HTTP calls and a small Socket.IO 2 exchange: written here (no runtime
  dependency), with node-homey-api and the Homey Web API docs read as
  documentation (nothing copied) and homeyHASS (MIT) for the mDNS service and
  the permissions. Credited in the README.
- **Engine.IO 3 / Socket.IO 2 on the WebSocket of Node.js** (global since Node
  22): the protocol node-homey-api speaks today. The client pings every
  `pingInterval`; a missing pong within `pingTimeout` ends the session. The
  handshake runs on the root namespace, then the client joins the namespace it
  returns (`/api`). homeyHASS uses python-socketio 5 (Engine.IO 4) with a
  token in the namespace CONNECT: Homey takes both; Engine.IO 3 needs no token
  there.
- **The API key** is the only credential: the Homey Pro (2023) web app creates
  it (Settings → API Keys). Bearer header over HTTP, `token` of the
  `handshakeClient`. No OAuth / cloud session: the Athom cloud is not needed.
  Plain `http://<IP>` by default (the `localUrl` of Homey); `https://` works
  with a valid certificate only (the global WebSocket cannot skip the check):
  the `homeylocal.com` addresses have one.
- **Finding Homey**: no address typed → `scanNetwork('mdns')` on `_homey._tcp`,
  each address confirmed by the `X-Homey-ID` of the ping (port 80, the
  advertised port is not used). One Homey found, or the one of the saved id:
  its address and id are saved (`setConfig`); several → the status lists them.
  An address typed and 3 failures in a row (network, timeout, not a Homey) →
  one scan (at most every 10 minutes) for the saved id, the new address saved.
  `configUpdated` ignores a configuration whose address, key and interval are
  unchanged (the echo of our own `setConfig`).
- **Changes**: the realtime events are the main path; the whole device list is
  read every 5 minutes (missed events, renames), every 10 s while the socket is
  refused or lost (retried after 5 s, doubling up to 2 minutes; 5 minutes when
  refused for a permission). Right after the socket opens, the list is read
  once (the changes between the read and the subscriptions).
  `device.create/update/delete` rebuild the model after 2 s (debounce), a
  device with an unknown zone reads the zones again.
- **Presses**: a realtime `capability` event of a `button` capability (any
  value but `false`) is a press; without the socket, a new `lastUpdated` of
  it. A full read never sends a press when a socket ran since the previous
  read (it sent them; `liveEpoch`), nor at the connection. Two presses between
  two reads without the socket are one.
- **One Gladys device per Homey device**, external id `homey:<id>` (Homey
  UUIDs are stable), feature key = the capability id (`color` for hue +
  saturation). Name "device (zone)", the zone being the direct one.
- **Light or switch**: the device class `light` or the virtual class `light`
  (a plug "used for" a lamp), or a hue / temperature capability → light
  category; else switch (and `dim` → switch dimmer). Power and energy on the
  switch of a device with `onoff` (plug), else energy sensor
  (`ENERGY_SENSOR.POWER` / `INDEX`); voltage and current always energy sensor.
- **Colour**: hue + saturation (0…1) → RGB at full value (the brightness is
  `dim`); written as `light_hue`, `light_saturation`, then `light_mode: color`
  when the device has a setable `light_mode` in the other mode. With
  `light_mode`, only the active one of colour and temperature is read.
  **Colour temperature**: `light_temperature` 0 (coldest) … 1 (warmest) maps
  linearly to 153 … 500 mireds; a capability declaring kelvins (`max` > 1) is
  converted as kelvins.
- **Covers**: `windowcoverings_state` up / idle / down = Gladys OPEN 1 / STOP 0
  / CLOSE -1, the values the capability lists only; `windowcoverings_set` 0…1
  = position 0…100 %. Class `curtain` → curtain category.
- **Thermostats**: `target_temperature` bounds and step from the capability
  (4…35 °C otherwise), `thermostat_mode` auto / heat / cool / off = Gladys
  AUTO 3 / HEATING 1 / COOLING 2 / OFF 0, the listed values only.
- **Alarms**: booleans; `alarm_contact` true (open) = Gladys OPENING_SENSOR 0.
- **Buttons**: a setable `button` → BUTTON.PUSH (Gladys presses it: `true`),
  else BUTTON.CLICK; events of value 1 either way. Remotes whose presses are
  Flow triggers only are out of reach of the Web API (documented: a Flow
  pressing a virtual button).
- **Badges**: Homey unreachable → unreachable; a device `available: false` →
  unreachable, degraded, with Homey's `unavailableMessage` (the SDK shows a
  message only with `degraded`); the socket down → local, degraded.
- **Not supported models**: Homey Pro (Early 2019) and older have no API keys
  nor local API (homeyHASS, Homey community); Homey Cloud has no local API.
  Homey Pro mini and Self-Hosted Server are expected to work (same software),
  untested.
