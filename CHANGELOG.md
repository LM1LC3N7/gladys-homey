# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

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
