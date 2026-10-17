# Homey Pro bridge

This integration connects Gladys to **your Homey Pro** and offers every Homey
device in the **Discovery** tab of Gladys: lights, plugs, shutters,
thermostats, locks, buttons, sensors, meters. Once a device is added, its
states follow Homey **live**, and Gladys controls it **through Homey**, which
keeps its Zigbee, Z-Wave, Matter, Wi-Fi and app devices. Move to Gladys at your
own pace, room after room, or use both side by side. Everything stays on your
local network. Unofficial, not affiliated with Athom.

> **Development version (0.1).** Written from the Homey Web API documentation
> and tested against a simulated Homey Pro, not yet on a real one. Your
> feedback is welcome on the GitHub repository.

## Which Homey

| Homey                            | Works?                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| Homey Pro (Early 2023)           | Yes: it has the local API and the API keys this integration uses.                   |
| Homey Pro mini                   | Probably: same Homey Pro software, with API keys. Not tested yet.                   |
| Homey Self-Hosted Server         | Probably, if it offers the API keys. Not tested yet.                                |
| Homey Pro (Early 2019) and older | No: they have neither API keys nor local API (an MQTT bridge app is the way there). |
| Homey Cloud (Homey Bridge)       | No: it runs in Athom's cloud, there is no API on your local network.                |

## What you get

| Homey capability                                                                          | In Gladys                                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `onoff`, `dim`                                                                            | a light (light devices, or a plug used for a lamp), else a switch |
| `light_hue` + `light_saturation`, `light_temperature`, `light_mode`                       | colour (RGB) and colour temperature, the one Homey shows          |
| `windowcoverings_state` (up / stop / down), `windowcoverings_set`                         | a shutter (or a curtain): open, close, stop, position             |
| `target_temperature`, `thermostat_mode` (auto, heat, cool, off)                           | a thermostat: setpoint and mode                                   |
| `locked`                                                                                  | a lock                                                            |
| `button`                                                                                  | a button: every press is an event for your scenes, pushable       |
| `measure_temperature`, `_humidity`, `_pressure`, `_luminance`, `_co2`, `_pm25`, `_noise`  | the sensor of the right category                                  |
| `measure_power`, `meter_power`, `measure_voltage`, `measure_current`                      | power and energy (on the switch of a plug), voltage, current      |
| `meter_gas`, `meter_water`                                                                | a volume in m³                                                    |
| `measure_battery`, `alarm_battery`                                                        | the battery level, battery low                                    |
| `alarm_motion`, `alarm_contact`, `alarm_water`, `alarm_smoke`, `alarm_co`, `alarm_tamper` | motion, opening, leak, smoke, CO and tamper sensors               |

Each Homey device makes **one Gladys device**, named after the device and its
zone ("Lamp (Living room)"); its Homey id, zone, class and driver are kept in
its parameters. The sub-capabilities of a device ("onoff.2", a second outlet;
"measure_temperature.outside") become features of their own, named with their
Homey title. Devices with none of these capabilities (speakers, for now) are
left out.

## Requirements

- A Homey Pro (Early 2023), see above, on the same local network as Gladys.
- An **API key** of that Homey.

## Installation

1. Open the Homey web app (<https://my.homey.app>), **Settings → API Keys →
   New API Key**. Give it a name ("Gladys") and these permissions:
   - **View devices** and **Control devices** (required);
   - **View zones** (the room in the device names);
   - **View System** (the live updates: without it, Gladys reads the devices
     every 10 seconds).

   Homey shows the key once: copy it.

2. In Gladys, open the integration, **Configuration**:
   - **Homey API key**: paste it.
   - **Address of Homey**: leave it empty, Gladys finds your Homey on the local
     network. Or type its IP address, like `192.168.1.20`. Not a `.local`
     name: the integration runs in its own container and cannot resolve them.
3. Click **Test the connection**: the Homey version, its address, the number
   of devices and zones, the devices offered and whether the live updates
   work show up.
4. Open the **Discovery** tab and add the devices you want. Their values are
   sent as soon as they are added.

## Options

- **Minimum interval between two readings of a sensor**: 10 seconds by default
  (0 to 300). A plug that reports its power every second is sent to Gladys at
  this pace. Switches, lights, buttons, motion and opening sensors are never
  delayed.
- **Allow unlocking from Gladys** (off by default): without it, Gladys can lock
  a lock, never unlock it.
- **Allow garage door and gate control** (off by default): without it, the
  commands of the Homey devices of class garage door or gate (switch, cover,
  button) are refused.
- **Allow valve and sprinkler control** (off by default): without it, opening
  or cutting a valve or a sprinkler is refused.
- **Allow alarm and siren control** (off by default): without it, arming,
  disarming or silencing an alarm or a siren is refused.

These commands still show as controllable in Gladys (the features are frozen
when the device is created): the integration refuses them, with a message,
while the option is off, devices added earlier included. Once allowed, each
such command first reads the device again from Homey and is refused when its
state is unknown or Homey says it is unavailable. The class used is the Homey
one (or its virtual class, chosen in the Homey app).

## Good to know

- **Homey stays in charge of the devices**: Gladys sends its commands to Homey,
  which drives them. Keep Homey running.
- **Live updates**: the changes reach Gladys within a second. The whole list
  is read again every 5 minutes. When the live updates are refused or lost,
  the devices are read every 10 seconds meanwhile, and Gladys tries the live
  updates again in the background.
- **Buttons**: the buttons Homey exposes as a capability (Homey's virtual
  buttons, the buttons of some apps) send every press to your scenes, and
  Gladys can press them. Most remotes (IKEA, Hue, Aqara…) only exist as Flow
  triggers in Homey, which the Web API does not show: make a Homey Flow that
  presses a virtual button, and use that button in Gladys.
- **Colours**: a bulb in colour mode shows its colour, in white mode its colour
  temperature (the Homey `light_mode`); Gladys switches the mode when it sets
  one or the other.
- **Door contacts**: Homey says "contact alarm" for an open door, Gladys 0 for
  open and 1 for closed; the integration converts.
- **Transport badge**: a device turns "unreachable" when Homey is, or when Homey
  marks it unavailable (with Homey's reason); an orange dot means the live
  updates are off and the state is read every 10 seconds.
- **Devices added, renamed or moved** in Homey show up in Discovery within
  seconds (at the latest at the next full read). The **Scan** button reads them
  at once.
- **A new IP address** (DHCP): when Homey stops answering, Gladys looks for it
  on the network by its id and keeps its new address.

## Troubleshooting

| Status message                           | What to do                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Homey refused the API key                | Create a new key (Settings → API Keys) and paste it.                                                 |
| The API key lacks a permission           | Create a key with View devices, Control devices, View zones and View System.                         |
| Homey refused the live updates           | Give the key the View System permission (create a new key). Meanwhile Gladys reads every 10 seconds. |
| No Homey Pro found on the network        | Type the IP address of Homey in the configuration.                                                   |
| Several Homeys found                     | Type the address of yours in the configuration.                                                      |
| No Homey Pro answers at this address     | Check the IP address. A Homey Pro (Early 2019) or a Homey Cloud cannot be used.                      |
| Homey is unreachable: connection refused | Check the address, seen from the Gladys machine (not `localhost`), and that Homey is on.             |

The logs of the integration (Gladys, integration page) give the details.

## Privacy

Everything stays on your local network: the integration only talks to your
Homey, over its local API. The API key is stored as a secret by Gladys and
never written to the logs. Homey is a trademark of Athom B.V.; this integration
is not affiliated with Athom.
