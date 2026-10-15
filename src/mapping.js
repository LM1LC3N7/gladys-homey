// -----------------------------------------------------------------------------
// One Homey device -> Gladys features, readers and writers (pure).
//
// A Homey device lists its capabilities (`capabilities`) and their state
// (`capabilitiesObj[id]`: value, lastUpdated, type, getable, setable, title,
// units, min, max, step, values…). The standard capabilities have fixed units
// (measure_temperature in °C, dim and windowcoverings_set from 0 to 1,
// light_temperature 0 = coldest … 1 = warmest); a sub-capability
// ("measure_temperature.outside", "onoff.2") behaves like its base.
// `mapDevice` returns:
//   features  the Gladys features (key: the capability id, or `color` for
//             light_hue + light_saturation; part of the external id: never
//             change a key),
//   readers   [{ key, caps, read(device) -> { state } | null, event }]: `caps`
//             are the capabilities it reads (a realtime event of one of them
//             runs it); an `event` reader is a button press, never read from
//             a stored value, and sent even when it is the same as the last,
//   writers   { [key]: { write(value, device) -> [{ capabilityId, value }] } }
//             (one capability set per entry; `device` is the last one read),
//   throttled the keys of the measurements (spaced by the sensor interval),
//   skipped   the capabilities left out (nothing to map them to yet).
// Value conventions: the Gladys side follows the enums of
// server/utils/constants.js in the Gladys core (copied here, the SDK does not
// export them).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';

// Value enums of the Gladys core (server/utils/constants.js), not in the SDK.
export const COVER_STATE = { STOP: 0, OPEN: 1, CLOSE: -1 };
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_STATUS = { CLICK: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };
export const THERMOSTAT_MODE = { OFF: 0, HEATING: 1, COOLING: 2, AUTO: 3 };

/** Homey windowcoverings_state -> Gladys cover state. */
const COVER_STATES = { up: COVER_STATE.OPEN, idle: COVER_STATE.STOP, down: COVER_STATE.CLOSE };
/** Homey thermostat_mode -> Gladys thermostat mode. */
const THERMOSTAT_MODES = {
  off: THERMOSTAT_MODE.OFF,
  heat: THERMOSTAT_MODE.HEATING,
  cool: THERMOSTAT_MODE.COOLING,
  auto: THERMOSTAT_MODE.AUTO,
};

const keyOf = (map, value) => Object.keys(map).find((k) => map[k] === value);
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const round = (n, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const cut = (text, max = 100) => String(text ?? '').slice(0, max);

/** "measure_temperature.outside" -> "measure_temperature". */
export const baseOf = (capabilityId) => String(capabilityId).split('.')[0];

const capOf = (device, id) => device?.capabilitiesObj?.[id];
const valueOf = (device, id) => capOf(device, id)?.value;

// --- Colours ----------------------------------------------------------------------

export const colorToInt = (r, g, b) =>
  ((Number(r) & 255) << 16) | ((Number(g) & 255) << 8) | (Number(b) & 255);

/** Homey light_hue and light_saturation (0…1) -> an RGB integer, at full value. */
export function hsToRgbInt(hue, saturation) {
  const h = (((Number(hue) % 1) + 1) % 1) * 6;
  const s = clamp(Number(saturation), 0, 1);
  const i = Math.floor(h);
  const f = h - i;
  const p = 1 - s;
  const q = 1 - s * f;
  const t = 1 - s * (1 - f);
  const [r, g, b] = [
    [1, t, p],
    [q, 1, p],
    [p, 1, t],
    [p, q, 1],
    [t, p, 1],
    [1, p, q],
  ][i % 6];
  return colorToInt(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255));
}

/** An RGB integer -> Homey light_hue and light_saturation (0…1); the value is the brightness. */
export function rgbIntToHs(n) {
  const rgb = clamp(Math.round(Number(n) || 0), 0, 0xffffff);
  const r = ((rgb >> 16) & 255) / 255;
  const g = ((rgb >> 8) & 255) / 255;
  const b = (rgb & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) {
      h = ((g - b) / d) % 6;
    } else if (max === g) {
      h = (b - r) / d + 2;
    } else {
      h = (r - g) / d + 4;
    }
    h /= 6;
    if (h < 0) {
      h += 1;
    }
  }
  return { hue: round(h), saturation: round(max === 0 ? 0 : d / max) };
}

/** Gladys colour temperatures in mireds. */
export const MIREDS = { min: 153, max: 500 };

/**
 * Homey light_temperature -> mireds. The standard capability goes from 0
 * (coldest) to 1 (warmest); a few drivers declare a range in kelvins instead
 * (`max` above 1).
 */
export function temperatureToMireds(value, cap = {}) {
  if (!finite(value)) {
    return undefined;
  }
  if (finite(cap.max) && cap.max > 1) {
    return value > 0 ? clamp(Math.round(1e6 / value), MIREDS.min, MIREDS.max) : undefined;
  }
  return Math.round(MIREDS.min + clamp(value, 0, 1) * (MIREDS.max - MIREDS.min));
}

export function miredsToTemperature(mireds, cap = {}) {
  const m = clamp(Number(mireds) || MIREDS.min, MIREDS.min, MIREDS.max);
  if (finite(cap.max) && cap.max > 1) {
    const min = finite(cap.min) ? cap.min : 0;
    return clamp(Math.round(1e6 / m), min, cap.max);
  }
  return round((m - MIREDS.min) / (MIREDS.max - MIREDS.min));
}

// --- Specs ------------------------------------------------------------------------

const decimal = (category, min, max, unit, type = T.SENSOR.DECIMAL) => ({
  category,
  type,
  min,
  max,
  unit,
});

/** The measurements: read-only numbers in the fixed unit of the Homey capability. */
const MEASURES = {
  measure_temperature: decimal(C.TEMPERATURE_SENSOR, -100, 150, U.CELSIUS),
  measure_humidity: decimal(C.HUMIDITY_SENSOR, 0, 100, U.PERCENT),
  measure_pressure: decimal(C.PRESSURE_SENSOR, 0, 2000, U.MILLIBAR),
  measure_luminance: decimal(C.LIGHT_SENSOR, 0, 200_000, U.LUX),
  measure_co2: decimal(C.CO2_SENSOR, 0, 100_000, U.PPM),
  measure_pm25: decimal(C.PM25_SENSOR, 0, 10_000, U.MICROGRAM_PER_CUBIC_METER),
  measure_noise: decimal(C.NOISE_SENSOR, 0, 200, U.DECIBEL),
  measure_voltage: decimal(C.ENERGY_SENSOR, 0, 100_000, U.VOLT, T.ENERGY_SENSOR.VOLTAGE),
  measure_current: decimal(C.ENERGY_SENSOR, 0, 100_000, U.AMPERE, T.ENERGY_SENSOR.CURRENT),
  measure_battery: decimal(C.BATTERY, 0, 100, U.PERCENT, T.BATTERY.INTEGER),
  meter_gas: decimal(C.VOLUME_SENSOR, 0, 1e12, U.CUBIC_METER),
  meter_water: decimal(C.VOLUME_SENSOR, 0, 1e12, U.CUBIC_METER),
};

/** Power and energy: on the switch of a plug, or an energy sensor. */
const POWER = {
  switch: decimal(C.SWITCH, 0, 1e9, U.WATT, T.SWITCH.POWER),
  sensor: decimal(C.ENERGY_SENSOR, -1e9, 1e9, U.WATT, T.ENERGY_SENSOR.POWER),
};
const ENERGY = {
  switch: decimal(C.SWITCH, 0, 1e12, U.KILOWATT_HOUR, T.SWITCH.ENERGY),
  sensor: decimal(C.ENERGY_SENSOR, 0, 1e12, U.KILOWATT_HOUR, T.ENERGY_SENSOR.INDEX),
};

/** The alarms: booleans; `invert` when Homey's true is Gladys' 0. */
const ALARMS = {
  alarm_motion: { category: C.MOTION_SENSOR, type: T.SENSOR.BINARY },
  // Homey: true = the contact is open. Gladys: OPEN 0, CLOSE 1.
  alarm_contact: { category: C.OPENING_SENSOR, type: T.SENSOR.BINARY, invert: true },
  alarm_water: { category: C.LEAK_SENSOR, type: T.SENSOR.BINARY },
  alarm_smoke: { category: C.SMOKE_SENSOR, type: T.SENSOR.BINARY },
  alarm_co: { category: C.CO_SENSOR, type: T.SENSOR.BINARY },
  alarm_tamper: { category: C.TAMPER, type: T.TAMPER.BINARY },
  alarm_battery: { category: C.BATTERY_LOW, type: T.BATTERY_LOW.BINARY },
};

/** Names of the features whose Homey title is missing (Homey gives one in its language). */
const LABELS = {
  onoff: 'On/off',
  dim: 'Brightness',
  light_temperature: 'Colour temperature',
  windowcoverings_state: 'Open/close',
  windowcoverings_set: 'Position',
  target_temperature: 'Target temperature',
  thermostat_mode: 'Thermostat mode',
  locked: 'Locked',
  button: 'Button',
  measure_temperature: 'Temperature',
  measure_humidity: 'Humidity',
  measure_pressure: 'Pressure',
  measure_luminance: 'Luminance',
  measure_co2: 'CO2',
  measure_pm25: 'PM2.5',
  measure_noise: 'Noise',
  measure_power: 'Power',
  measure_voltage: 'Voltage',
  measure_current: 'Current',
  measure_battery: 'Battery',
  meter_power: 'Energy',
  meter_gas: 'Gas',
  meter_water: 'Water',
  alarm_motion: 'Motion',
  alarm_contact: 'Contact',
  alarm_water: 'Water leak',
  alarm_smoke: 'Smoke',
  alarm_co: 'Carbon monoxide',
  alarm_tamper: 'Tamper',
  alarm_battery: 'Battery low',
};

/** The capabilities whose feature is named after the device itself. */
const MAIN = new Set(['onoff', 'windowcoverings_state', 'locked']);

// --- The device -------------------------------------------------------------------

class DeviceMapper {
  /** @param {object} device one device of GET /api/manager/devices/device */
  constructor(device) {
    this.d = device;
    this.name = String(device.name ?? '').trim() || `Homey ${String(device.id).slice(0, 8)}`;
    const caps = Array.isArray(device.capabilities) ? device.capabilities : [];
    this.caps = caps.filter((c) => typeof c === 'string');
    this.has = (id) => this.caps.includes(id);
    const lighting = [device.class, device.virtualClass].includes('light');
    this.light = lighting || this.has('light_hue') || this.has('light_temperature');
    this.features = [];
    this.readers = [];
    this.writers = {};
    this.throttled = new Set();
    this.skipped = [];
  }

  cap(id) {
    return capOf(this.d, id) ?? {};
  }

  setable(id) {
    return this.cap(id).setable !== false;
  }

  /** The feature name: the device for its main capability, else "Device – Title". */
  nameOf(id) {
    if (MAIN.has(id)) {
      return this.name;
    }
    const title = this.cap(id).title;
    const label =
      typeof title === 'string' && title.trim() !== ''
        ? title.trim()
        : `${LABELS[baseOf(id)] ?? baseOf(id)}${id.includes('.') ? ` ${id.split('.').slice(1).join('.')}` : ''}`;
    return `${this.name} – ${label}`;
  }

  /**
   * One feature.
   * @param {string} key part of the external id: never change it
   * @param {string[]} caps the capabilities it reads
   * @param {object} spec category, type, unit, min, max
   * @param {{ read?: Function, write?: Function, throttle?: boolean, event?: boolean, feedback?: boolean }} io
   */
  add(key, name, caps, spec, { read, write, throttle = false, event = false, feedback } = {}) {
    if (this.features.some((f) => f.key === key)) {
      return;
    }
    const feature = {
      key,
      name: cut(name),
      category: spec.category,
      type: spec.type,
      min: spec.min ?? 0,
      max: spec.max ?? 1,
      read_only: !write,
      // Feedback: Homey reports the new value back (realtime or read).
      has_feedback: feedback ?? Boolean(write && read && !event),
      keep_history: true,
    };
    if (spec.unit) {
      feature.unit = spec.unit;
    }
    this.features.push(feature);
    if (read) {
      this.readers.push({ key, caps, read, event });
    }
    if (write) {
      this.writers[key] = { write };
    }
    if (throttle) {
      this.throttled.add(key);
    }
  }

  // --- Lights and switches --------------------------------------------------------

  onoff(id) {
    const [category, type] = this.light ? [C.LIGHT, T.LIGHT.BINARY] : [C.SWITCH, T.SWITCH.BINARY];
    this.add(
      id,
      this.nameOf(id),
      [id],
      { category, type, min: 0, max: 1 },
      {
        read: (d) => {
          const v = valueOf(d, id);
          return typeof v === 'boolean' ? { state: v ? 1 : 0 } : null;
        },
        write: this.setable(id)
          ? (value) => [{ capabilityId: id, value: Number(value) > 0 }]
          : undefined,
      },
    );
  }

  /** A 0…1 capability (dim, windowcoverings_set) as 0…100 %. */
  percent(id, spec) {
    const range = () => {
      const cap = this.cap(id);
      const min = finite(cap.min) ? cap.min : 0;
      const max = finite(cap.max) && cap.max > min ? cap.max : 1;
      return { min, max };
    };
    this.add(id, this.nameOf(id), [id], spec, {
      read: (d) => {
        const v = valueOf(d, id);
        if (!finite(v)) {
          return null;
        }
        const { min, max } = range();
        return { state: clamp(Math.round(((v - min) / (max - min)) * 100), 0, 100) };
      },
      write: this.setable(id)
        ? (value) => {
            const { min, max } = range();
            const ratio = clamp(Number(value) || 0, 0, 100) / 100;
            return [{ capabilityId: id, value: round(min + ratio * (max - min)) }];
          }
        : undefined,
    });
  }

  dim(id) {
    const spec = this.light
      ? { category: C.LIGHT, type: T.LIGHT.BRIGHTNESS, min: 0, max: 100 }
      : { category: C.SWITCH, type: T.SWITCH.DIMMER, min: 0, max: 100 };
    this.percent(id, spec);
  }

  /** light_mode, when the device has it: which of colour and temperature is shown. */
  mode(d) {
    return this.has('light_mode') ? valueOf(d, 'light_mode') : undefined;
  }

  /** Switches the light_mode after a colour or temperature, when it is not already that one. */
  modeCall(wanted, d) {
    if (!this.has('light_mode') || !this.setable('light_mode') || this.mode(d) === wanted) {
      return [];
    }
    return [{ capabilityId: 'light_mode', value: wanted }];
  }

  color() {
    const hueTitle = this.cap('light_hue').title;
    const satTitle = this.cap('light_saturation').title;
    const label = hueTitle && satTitle ? `${hueTitle} / ${satTitle}` : 'Colour';
    const setable = this.setable('light_hue') && this.setable('light_saturation');
    this.add(
      'color',
      `${this.name} – ${label}`,
      ['light_hue', 'light_saturation', 'light_mode'],
      { category: C.LIGHT, type: T.LIGHT.COLOR, min: 0, max: 0xffffff },
      {
        read: (d) => {
          const hue = valueOf(d, 'light_hue');
          const saturation = valueOf(d, 'light_saturation');
          if (this.mode(d) === 'temperature' || !finite(hue) || !finite(saturation)) {
            return null;
          }
          return { state: hsToRgbInt(hue, saturation) };
        },
        write: setable
          ? (value, d) => {
              const { hue, saturation } = rgbIntToHs(value);
              return [
                { capabilityId: 'light_hue', value: hue },
                { capabilityId: 'light_saturation', value: saturation },
                ...this.modeCall('color', d),
              ];
            }
          : undefined,
      },
    );
  }

  temperature(id) {
    this.add(
      id,
      this.nameOf(id),
      [id, 'light_mode'],
      { category: C.LIGHT, type: T.LIGHT.TEMPERATURE, min: MIREDS.min, max: MIREDS.max },
      {
        read: (d) => {
          if (this.mode(d) === 'color') {
            return null;
          }
          const mireds = temperatureToMireds(valueOf(d, id), capOf(d, id));
          return mireds === undefined ? null : { state: mireds };
        },
        write: this.setable(id)
          ? (value, d) => [
              { capabilityId: id, value: miredsToTemperature(value, capOf(d, id) ?? this.cap(id)) },
              ...this.modeCall('temperature', d),
            ]
          : undefined,
      },
    );
  }

  // --- Covers ---------------------------------------------------------------------

  coverCategory() {
    return [this.d.class, this.d.virtualClass].includes('curtain') ? C.CURTAIN : C.SHUTTER;
  }

  coverState(id) {
    const category = this.coverCategory();
    const types = category === C.CURTAIN ? T.CURTAIN : T.SHUTTER;
    const known = (this.cap(id).values ?? []).map((v) => v?.id).filter(Boolean);
    this.add(
      id,
      this.nameOf(id),
      [id],
      { category, type: types.STATE, min: -1, max: 1 },
      {
        read: (d) => {
          const state = COVER_STATES[valueOf(d, id)];
          return state === undefined ? null : { state };
        },
        write: this.setable(id)
          ? (value) => {
              const wanted = keyOf(COVER_STATES, Number(value));
              if (!wanted || (known.length > 0 && !known.includes(wanted))) {
                throw new Error(`${this.name} cannot do ${value}`);
              }
              return [{ capabilityId: id, value: wanted }];
            }
          : undefined,
      },
    );
  }

  coverPosition(id) {
    const category = this.coverCategory();
    const types = category === C.CURTAIN ? T.CURTAIN : T.SHUTTER;
    this.percent(id, { category, type: types.POSITION, min: 0, max: 100 });
  }

  // --- Climate --------------------------------------------------------------------

  targetTemperature(id) {
    const cap = this.cap(id);
    const min = finite(cap.min) ? cap.min : 4;
    const max = finite(cap.max) && cap.max > min ? cap.max : 35;
    const step = finite(cap.step) && cap.step > 0 ? cap.step : undefined;
    this.add(
      id,
      this.nameOf(id),
      [id],
      { category: C.THERMOSTAT, type: T.THERMOSTAT.TARGET_TEMPERATURE, min, max, unit: U.CELSIUS },
      {
        read: (d) => {
          const v = valueOf(d, id);
          return finite(v) ? { state: v } : null;
        },
        write: this.setable(id)
          ? (value) => {
              let v = clamp(Number(value), min, max);
              if (!Number.isFinite(v)) {
                throw new Error(`${value} is not a temperature`);
              }
              if (step) {
                v = round(Math.round(v / step) * step, 3);
              }
              return [{ capabilityId: id, value: v }];
            }
          : undefined,
      },
    );
  }

  thermostatMode(id) {
    const known = (this.cap(id).values ?? []).map((v) => v?.id).filter(Boolean);
    this.add(
      id,
      this.nameOf(id),
      [id],
      { category: C.THERMOSTAT, type: T.THERMOSTAT.MODE, min: 0, max: 3 },
      {
        read: (d) => {
          const mode = THERMOSTAT_MODES[valueOf(d, id)];
          return mode === undefined ? null : { state: mode };
        },
        write: this.setable(id)
          ? (value) => {
              const wanted = keyOf(THERMOSTAT_MODES, Number(value));
              if (!wanted || (known.length > 0 && !known.includes(wanted))) {
                throw new Error(`${this.name} has no mode ${value}`);
              }
              return [{ capabilityId: id, value: wanted }];
            }
          : undefined,
      },
    );
  }

  // --- Sensors --------------------------------------------------------------------

  measure(id, spec) {
    this.add(id, this.nameOf(id), [id], spec, {
      read: (d) => {
        const v = valueOf(d, id);
        if (!finite(v)) {
          return null;
        }
        return { state: spec.type === T.BATTERY.INTEGER ? Math.round(v) : v };
      },
      throttle: true,
    });
  }

  alarm(id, { category, type, invert = false }) {
    this.add(
      id,
      this.nameOf(id),
      [id],
      { category, type, min: 0, max: 1 },
      {
        read: (d) => {
          const v = valueOf(d, id);
          if (typeof v !== 'boolean') {
            return null;
          }
          return { state: v !== invert ? 1 : 0 };
        },
      },
    );
  }

  lock(id) {
    this.add(
      id,
      this.nameOf(id),
      [id],
      { category: C.LOCK, type: T.LOCK.BINARY, min: 0, max: 1 },
      {
        read: (d) => {
          const v = valueOf(d, id);
          return typeof v === 'boolean' ? { state: v ? 1 : 0 } : null;
        },
        write: this.setable(id)
          ? (value) => [{ capabilityId: id, value: Number(value) > 0 }]
          : undefined,
      },
    );
  }

  /**
   * A button: every press is an event. Pressed from Gladys too when Homey
   * lets it be set (the buttons of the Homey interface, virtual buttons).
   */
  button(id) {
    const pushable = this.setable(id);
    this.add(
      id,
      this.nameOf(id),
      [id],
      {
        category: C.BUTTON,
        type: pushable ? T.BUTTON.PUSH : T.BUTTON.CLICK,
        min: 0,
        max: 1,
      },
      {
        read: () => ({ state: pushable ? BUTTON_PUSH.PRESSED : BUTTON_STATUS.CLICK }),
        event: true,
        write: pushable ? () => [{ capabilityId: id, value: true }] : undefined,
        feedback: false,
      },
    );
  }

  // --- The device -----------------------------------------------------------------

  map() {
    const hasSwitch = this.caps.some((c) => baseOf(c) === 'onoff');
    for (const id of this.caps) {
      const base = baseOf(id);
      switch (base) {
        case 'onoff':
          this.onoff(id);
          break;
        case 'dim':
          this.dim(id);
          break;
        case 'light_hue':
        case 'light_saturation':
          if (this.has('light_hue') && this.has('light_saturation')) {
            this.color();
          } else {
            this.skipped.push(id);
          }
          break;
        case 'light_temperature':
          this.temperature(id);
          break;
        case 'light_mode':
          // Read with the colour and the temperature.
          break;
        case 'windowcoverings_state':
          this.coverState(id);
          break;
        case 'windowcoverings_set':
          this.coverPosition(id);
          break;
        case 'target_temperature':
          this.targetTemperature(id);
          break;
        case 'thermostat_mode':
          this.thermostatMode(id);
          break;
        case 'measure_power':
          this.measure(id, hasSwitch ? POWER.switch : POWER.sensor);
          break;
        case 'meter_power':
          this.measure(id, hasSwitch ? ENERGY.switch : ENERGY.sensor);
          break;
        case 'locked':
          this.lock(id);
          break;
        case 'button':
          this.button(id);
          break;
        default:
          if (MEASURES[base]) {
            this.measure(id, MEASURES[base]);
          } else if (ALARMS[base]) {
            this.alarm(id, ALARMS[base]);
          } else {
            this.skipped.push(id);
          }
      }
    }
    return {
      features: this.features,
      readers: this.readers,
      writers: this.writers,
      throttled: this.throttled,
      skipped: this.skipped,
    };
  }
}

/**
 * One Homey device -> features, readers, writers.
 * @param {object} device one device of GET /api/manager/devices/device
 */
export function mapDevice(device) {
  return new DeviceMapper(device).map();
}
