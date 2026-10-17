# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- Status and Discovery republished after Gladys restarts (the transport
  badges too).

## [0.1.2] - 2026-10-17

### Security

- Unlocking a lock (its `locked` feature) from Gladys is now refused unless the
  new option "Allow unlocking from Gladys" (`allow_unlock`, off by default) is
  on; locking through `locked` is always allowed. The switch, brightness, cover
  and button of a lock (class `lock`, or a device with a `locked` capability)
  need the option both ways. If you unlocked from Gladys (dashboard, scenes,
  voice assistants), turn the option on.
- The switch, brightness, cover and button of the Homey devices of class (or
  virtual class) `garagedoor`, `watervalve`, `sprinkler`, `faucet`,
  `homealarm`, `smokealarm` or `siren`, or with a `garagedoor_closed` or
  `homealarm_state` capability, are now refused unless their new option is on:
  `allow_garage_door_control`, `allow_valve_control`, `allow_alarm_control`
  (off by default). `watervalve`, `sprinkler` and `siren` exist since Homey
  12.0. A valve, a siren or a gate relay filed under another class (`socket`,
  `relay`, `other`, `sensor`) without those capabilities is not protected.
- The check runs on every command, so devices added before this version are
  covered too; their keys and external ids do not change. A command for a
  device Homey no longer knows (deleted, model not rebuilt yet) is refused.
- Once allowed, such a command reads the device from Homey just before, and is
  refused when that read fails, when Homey says the device is unavailable, or
  when the state is unknown (so a capability with `getable` false is refused
  even with the option); it is decided on the state read, never on the one in
  memory.
- Guarded commands run one at a time per device, the others one at a time per
  feature. A command not sent within 3.5 s of its arrival is refused before its
  first request leaves (Gladys waits 5 s for the answer); a command of several
  requests goes on once its first request left.
- The refusal messages are in English and French and name the option to turn
  on.

### Changed

- README: the store install note replaces the work-in-progress notice, and the
  Releasing section no longer says the store topic is still to be added.

## [0.1.1] - 2026-10-16

### Added

- Connection to a Homey Pro (Early 2023) through its local Web API, with an
  API key; Homey found on the local network by mDNS when no address is typed,
  and found again by its id when its address changes.
- Every Homey device offered in Discovery, one Gladys device per Homey
  device, named after its zone; sub-capabilities as features of their own.
- Lights (on/off, brightness, colour, colour temperature, following the light
  mode), switches and plugs with their power and energy, shutters and curtains
  (open, close, stop, position), thermostats (setpoint, mode), locks, buttons
  (every press an event, pushable from Gladys), temperature, humidity,
  pressure, luminance, CO2, PM2.5, noise, voltage, current, gas and water
  meters, battery levels, motion, door, leak, smoke, CO, tamper and battery
  alarms.
- Live updates through the Homey realtime events; the device list read again
  every 5 minutes, every 10 seconds when the live updates are unavailable.
- Gladys commands sent to Homey, the new state read back through its events.
- Transport badges: unreachable when Homey is, or when Homey marks the device
  unavailable (with its reason); degraded while the live updates are off.
- "Test the connection" button: Homey version and address, devices, zones,
  devices offered, live updates.

[Unreleased]: https://github.com/LM1LC3N7/gladys-homey/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-homey/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-homey/releases/tag/v0.1.1
