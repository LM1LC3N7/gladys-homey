// -----------------------------------------------------------------------------
// One Homey device -> features, readers, writers: the devices of the
// fixtures (one of each kind) and a few made records for the edge cases.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  COVER_STATE,
  MIREDS,
  OPENING_SENSOR_STATE,
  THERMOSTAT_MODE,
  baseOf,
  guardOf,
  hsToRgbInt,
  mapDevice,
  miredsToTemperature,
  rgbIntToHs,
  temperatureToMireds,
} from '../src/mapping.js';
import { answers, deviceNamed } from './fixtures/homey.js';

const { devices } = answers();
const fixture = (name) => structuredClone(deviceNamed(devices, name));

/** A device of the fixtures, mapped: its features by key, and helpers. */
function mapped(name, change = (d) => d) {
  const device = change(fixture(name));
  const result = mapDevice(device);
  const features = Object.fromEntries(result.features.map((f) => [f.key, f]));
  const read = (key, d = device) => {
    const reader = result.readers.find((r) => r.key === key);
    assert.ok(reader, `${name} reads ${key}`);
    return reader.read(d)?.state ?? null;
  };
  const write = (key, value, d = device) => {
    assert.ok(result.writers[key], `${name} writes ${key}`);
    return result.writers[key].write(value, d).map((c) => [c.capabilityId, c.value]);
  };
  const withValue = (capabilityId, value) => {
    const copy = structuredClone(device);
    copy.capabilitiesObj[capabilityId].value = value;
    return copy;
  };
  return { device, result, features, read, write, withValue };
}

const spec = (f) => [f.category, f.type, f.unit, f.min, f.max, f.read_only];

test('colours: Homey hue and saturation <-> RGB integers', () => {
  assert.equal(hsToRgbInt(0, 1), 0xff0000);
  assert.equal(hsToRgbInt(1 / 3, 1), 0x00ff00);
  assert.equal(hsToRgbInt(2 / 3, 1), 0x0000ff);
  assert.equal(hsToRgbInt(0.5, 0), 0xffffff);
  assert.equal(hsToRgbInt(1, 1), 0xff0000, 'hue 1 is hue 0');
  assert.deepEqual(rgbIntToHs(0xff0000), { hue: 0, saturation: 1 });
  assert.deepEqual(rgbIntToHs(0xff8000), { hue: 0.0837, saturation: 1 });
  assert.deepEqual(rgbIntToHs(0xffffff), { hue: 0, saturation: 0 });
  assert.deepEqual(rgbIntToHs(0), { hue: 0, saturation: 0 });
  for (const rgb of [0x123456, 0xff00ff, 0x00ffff, 0x80ff00]) {
    const { hue, saturation } = rgbIntToHs(rgb);
    const back = hsToRgbInt(hue, saturation);
    const max = Math.max((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255) / 255;
    // The value (brightness) is the dim capability: compare at full value.
    const scaled = ((rgb >> 16) & 255) / max;
    assert.ok(Math.abs(((back >> 16) & 255) - scaled) <= 1, `${rgb.toString(16)}`);
  }
});

test('colour temperatures: 0 (cold) … 1 (warm) <-> mireds, kelvin ranges too', () => {
  assert.equal(temperatureToMireds(0), MIREDS.min);
  assert.equal(temperatureToMireds(1), MIREDS.max);
  assert.equal(temperatureToMireds(0.5), 327);
  assert.equal(temperatureToMireds(null), undefined);
  assert.equal(miredsToTemperature(153), 0);
  assert.equal(miredsToTemperature(500), 1);
  assert.equal(miredsToTemperature(1000), 1);
  const kelvin = { min: 2200, max: 6500 };
  assert.equal(temperatureToMireds(2700, kelvin), 370);
  assert.equal(miredsToTemperature(370, kelvin), 2703);
  assert.equal(miredsToTemperature(153, kelvin), 6500);
});

test('a colour bulb: on/off, brightness, colour and temperature, by light_mode', () => {
  const { features, read, write, withValue, result } = mapped('Lampe salon');
  assert.deepEqual(Object.keys(features), ['onoff', 'dim', 'color', 'light_temperature']);
  assert.deepEqual(spec(features.onoff), [C.LIGHT, T.LIGHT.BINARY, undefined, 0, 1, false]);
  assert.equal(features.onoff.name, 'Lampe salon');
  assert.equal(features.onoff.has_feedback, true);
  assert.deepEqual(spec(features.dim), [C.LIGHT, T.LIGHT.BRIGHTNESS, undefined, 0, 100, false]);
  assert.equal(features.dim.name, 'Lampe salon – Luminosité');
  assert.equal(features.color.name, 'Lampe salon – Teinte / Saturation');
  assert.deepEqual(spec(features.color), [C.LIGHT, T.LIGHT.COLOR, undefined, 0, 0xffffff, false]);
  assert.deepEqual(spec(features.light_temperature), [
    C.LIGHT,
    T.LIGHT.TEMPERATURE,
    undefined,
    153,
    500,
    false,
  ]);
  assert.equal(read('onoff'), 1);
  assert.equal(read('dim'), 50);
  assert.equal(read('color'), 0x0000ff);
  assert.equal(read('light_temperature'), null, 'colour mode');
  const warm = withValue('light_mode', 'temperature');
  assert.equal(read('light_temperature', warm), 257);
  assert.equal(read('color', warm), null, 'temperature mode');
  assert.deepEqual(result.readers.find((r) => r.key === 'color').caps, [
    'light_hue',
    'light_saturation',
    'light_mode',
  ]);
  assert.deepEqual(write('onoff', 1), [['onoff', true]]);
  assert.deepEqual(write('dim', 120), [['dim', 1]]);
  assert.deepEqual(write('color', 0x00ff00), [
    ['light_hue', 0.3333],
    ['light_saturation', 1],
  ]);
  assert.deepEqual(write('color', 0xff0000, warm), [
    ['light_hue', 0],
    ['light_saturation', 1],
    ['light_mode', 'color'],
  ]);
  assert.deepEqual(write('light_temperature', 327), [
    ['light_temperature', 0.5014],
    ['light_mode', 'temperature'],
  ]);
  assert.equal(result.throttled.size, 0);
});

test('a white bulb without light_mode reads its temperature always', () => {
  const { features, read, write } = mapped('Plafonnier');
  assert.deepEqual(Object.keys(features), ['onoff', 'dim', 'light_temperature']);
  assert.equal(read('light_temperature'), 153);
  assert.deepEqual(write('light_temperature', 500), [['light_temperature', 1]]);
});

test('plugs: a switch with its power and energy, or a light by its virtual class', () => {
  const plug = mapped('Prise TV');
  assert.deepEqual(spec(plug.features.onoff), [C.SWITCH, T.SWITCH.BINARY, undefined, 0, 1, false]);
  assert.deepEqual(spec(plug.features.measure_power), [
    C.SWITCH,
    T.SWITCH.POWER,
    U.WATT,
    0,
    1e9,
    true,
  ]);
  assert.deepEqual(spec(plug.features.meter_power), [
    C.SWITCH,
    T.SWITCH.ENERGY,
    U.KILOWATT_HOUR,
    0,
    1e12,
    true,
  ]);
  assert.deepEqual(spec(plug.features.measure_voltage).slice(0, 3), [
    C.ENERGY_SENSOR,
    T.ENERGY_SENSOR.VOLTAGE,
    U.VOLT,
  ]);
  assert.deepEqual(spec(plug.features.measure_current).slice(0, 3), [
    C.ENERGY_SENSOR,
    T.ENERGY_SENSOR.CURRENT,
    U.AMPERE,
  ]);
  assert.equal(plug.read('measure_power'), 85.4);
  assert.equal(plug.read('meter_power'), 1234.56);
  assert.deepEqual([...plug.result.throttled].sort(), [
    'measure_current',
    'measure_power',
    'measure_voltage',
    'meter_power',
  ]);

  const lamp = mapped('Prise lampadaire');
  assert.equal(lamp.features.onoff.category, C.LIGHT);

  const meter = mapped('Compteur Linky');
  assert.deepEqual(spec(meter.features.measure_power).slice(0, 5), [
    C.ENERGY_SENSOR,
    T.ENERGY_SENSOR.POWER,
    U.WATT,
    -1e9,
    1e9,
  ]);
  assert.deepEqual(spec(meter.features.meter_power).slice(0, 3), [
    C.ENERGY_SENSOR,
    T.ENERGY_SENSOR.INDEX,
    U.KILOWATT_HOUR,
  ]);
});

test('sub-capabilities: one feature each, named after their Homey title', () => {
  const { features, read, write } = mapped('Module double');
  assert.deepEqual(Object.keys(features), ['onoff', 'onoff.2', 'measure_power']);
  assert.equal(features['onoff.2'].name, 'Module double – Plan de travail');
  assert.equal(read('onoff.2'), 0);
  assert.deepEqual(write('onoff.2', 1), [['onoff.2', true]]);
  assert.equal(baseOf('measure_temperature.outside'), 'measure_temperature');

  const station = mapped('Station Netatmo');
  assert.equal(
    station.features['measure_temperature.outside'].name,
    'Station Netatmo – Température extérieure',
  );
  assert.equal(station.read('measure_temperature.outside'), 9.4);
  const untitled = mapDevice({
    id: 'x',
    name: 'Capteur',
    capabilities: ['measure_temperature.inside'],
    capabilitiesObj: { 'measure_temperature.inside': { value: 20 } },
  });
  assert.equal(untitled.features[0].name, 'Capteur – Temperature inside');
});

test('shutters and curtains: state up/idle/down, position 0…1 as %', () => {
  const { features, read, write, withValue } = mapped('Volet salon');
  assert.deepEqual(spec(features.windowcoverings_state), [
    C.SHUTTER,
    T.SHUTTER.STATE,
    undefined,
    -1,
    1,
    false,
  ]);
  assert.deepEqual(spec(features.windowcoverings_set), [
    C.SHUTTER,
    T.SHUTTER.POSITION,
    undefined,
    0,
    100,
    false,
  ]);
  assert.equal(features.windowcoverings_state.name, 'Volet salon');
  assert.equal(read('windowcoverings_state'), COVER_STATE.STOP);
  assert.equal(read('windowcoverings_state', withValue('windowcoverings_state', 'up')), 1);
  assert.equal(read('windowcoverings_state', withValue('windowcoverings_state', 'down')), -1);
  assert.equal(read('windowcoverings_state', withValue('windowcoverings_state', 'weird')), null);
  assert.equal(read('windowcoverings_set'), 40);
  assert.deepEqual(write('windowcoverings_state', COVER_STATE.CLOSE), [
    ['windowcoverings_state', 'down'],
  ]);
  assert.throws(() => write('windowcoverings_state', 5), /cannot do 5/);
  assert.deepEqual(write('windowcoverings_set', 33), [['windowcoverings_set', 0.33]]);

  const curtain = mapped('Rideau chambre');
  assert.equal(curtain.features.windowcoverings_set.category, C.CURTAIN);
  assert.equal(curtain.features.windowcoverings_set.type, T.CURTAIN.POSITION);
  assert.equal(curtain.read('windowcoverings_set'), 100);
});

test('thermostats: setpoint within its bounds and step, mode', () => {
  const { features, read, write, withValue } = mapped('Thermostat salon');
  assert.deepEqual(spec(features.target_temperature), [
    C.THERMOSTAT,
    T.THERMOSTAT.TARGET_TEMPERATURE,
    U.CELSIUS,
    5,
    30,
    false,
  ]);
  assert.deepEqual(spec(features.thermostat_mode), [
    C.THERMOSTAT,
    T.THERMOSTAT.MODE,
    undefined,
    0,
    3,
    false,
  ]);
  assert.equal(read('target_temperature'), 20.5);
  assert.equal(read('thermostat_mode'), THERMOSTAT_MODE.HEATING);
  assert.equal(read('thermostat_mode', withValue('thermostat_mode', 'off')), THERMOSTAT_MODE.OFF);
  assert.equal(read('thermostat_mode', withValue('thermostat_mode', 'eco')), null);
  assert.deepEqual(write('target_temperature', 19.74), [['target_temperature', 19.5]]);
  assert.deepEqual(write('target_temperature', 1), [['target_temperature', 5]]);
  assert.deepEqual(write('thermostat_mode', THERMOSTAT_MODE.COOLING), [
    ['thermostat_mode', 'cool'],
  ]);
  const heatOnly = mapped('Thermostat salon', (d) => {
    d.capabilitiesObj.thermostat_mode.values = [{ id: 'heat' }, { id: 'off' }];
    return d;
  });
  assert.throws(() => heatOnly.write('thermostat_mode', THERMOSTAT_MODE.AUTO), /has no mode 3/);
  assert.equal(features.measure_humidity.unit, U.PERCENT);

  const valve = mapped('Tête thermostatique');
  assert.deepEqual(
    [valve.features.target_temperature.min, valve.features.target_temperature.max],
    [4, 28],
  );
  const bare = mapDevice({
    id: 'y',
    name: 'Clim',
    capabilities: ['target_temperature'],
    capabilitiesObj: { target_temperature: { value: 22 } },
  });
  assert.deepEqual([bare.features[0].min, bare.features[0].max], [4, 35]);
  assert.deepEqual(
    bare.writers.target_temperature.write(22.37).map((c) => c.value),
    [22.37],
    'no step: kept',
  );
});

test('sensors: units and categories of the measurements', () => {
  const kinds = {
    'Capteur salon': {
      measure_temperature: [C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, U.CELSIUS],
      measure_humidity: [C.HUMIDITY_SENSOR, T.SENSOR.DECIMAL, U.PERCENT],
      measure_pressure: [C.PRESSURE_SENSOR, T.SENSOR.DECIMAL, U.MILLIBAR],
      measure_battery: [C.BATTERY, T.BATTERY.INTEGER, U.PERCENT],
    },
    'Détecteur entrée': {
      measure_luminance: [C.LIGHT_SENSOR, T.SENSOR.DECIMAL, U.LUX],
    },
    'Station Netatmo': {
      measure_co2: [C.CO2_SENSOR, T.SENSOR.DECIMAL, U.PPM],
      measure_noise: [C.NOISE_SENSOR, T.SENSOR.DECIMAL, U.DECIBEL],
    },
    Purificateur: {
      measure_pm25: [C.PM25_SENSOR, T.SENSOR.DECIMAL, U.MICROGRAM_PER_CUBIC_METER],
    },
    'Compteur gaz': { meter_gas: [C.VOLUME_SENSOR, T.SENSOR.DECIMAL, U.CUBIC_METER] },
    'Compteur eau': { meter_water: [C.VOLUME_SENSOR, T.SENSOR.DECIMAL, U.CUBIC_METER] },
  };
  for (const [name, expected] of Object.entries(kinds)) {
    const { features, result } = mapped(name);
    for (const [key, triple] of Object.entries(expected)) {
      assert.deepEqual(spec(features[key]).slice(0, 3), triple, `${name} ${key}`);
      assert.equal(features[key].read_only, true);
      assert.ok(result.throttled.has(key), `${key} is throttled`);
    }
  }
  const sensor = mapped('Capteur salon');
  assert.equal(sensor.read('measure_battery', sensor.withValue('measure_battery', 86.6)), 87);
  assert.equal(
    sensor.read('measure_temperature', sensor.withValue('measure_temperature', null)),
    null,
  );
  assert.equal(mapped('Compteur gaz').read('meter_gas'), 4521.334);
});

test('alarms: motion, contact (open is 0 in Gladys), leak, smoke, CO, tamper, battery', () => {
  const door = mapped("Porte d'entrée");
  assert.deepEqual(spec(door.features.alarm_contact), [
    C.OPENING_SENSOR,
    T.SENSOR.BINARY,
    undefined,
    0,
    1,
    true,
  ]);
  assert.equal(door.read('alarm_contact'), OPENING_SENSOR_STATE.CLOSE);
  assert.equal(
    door.read('alarm_contact', door.withValue('alarm_contact', true)),
    OPENING_SENSOR_STATE.OPEN,
  );
  assert.deepEqual(spec(door.features.alarm_battery).slice(0, 2), [
    C.BATTERY_LOW,
    T.BATTERY_LOW.BINARY,
  ]);
  assert.equal(door.result.throttled.size, 1, 'only the battery level is throttled');

  const motion = mapped('Détecteur entrée');
  assert.deepEqual(spec(motion.features.alarm_motion).slice(0, 2), [
    C.MOTION_SENSOR,
    T.SENSOR.BINARY,
  ]);
  assert.equal(motion.read('alarm_motion', motion.withValue('alarm_motion', true)), 1);
  assert.deepEqual(spec(motion.features.alarm_tamper).slice(0, 2), [C.TAMPER, T.TAMPER.BINARY]);
  assert.equal(mapped('Fuite cuisine').features.alarm_water.category, C.LEAK_SENSOR);
  const smoke = mapped('Détecteur fumée');
  assert.equal(smoke.features.alarm_smoke.category, C.SMOKE_SENSOR);
  assert.equal(smoke.features.alarm_co.category, C.CO_SENSOR);
  assert.equal(smoke.read('alarm_smoke'), 0);
  assert.equal(smoke.read('alarm_smoke', smoke.withValue('alarm_smoke', null)), null);
});

test('the guarded commands: by capability and by class or virtual class', () => {
  const device = (cls, virtualClass = null) => ({
    id: 'g',
    name: 'G',
    class: cls,
    virtualClass,
    capabilities: ['onoff', 'windowcoverings_state', 'dim', 'button', 'target_temperature'],
    capabilitiesObj: {},
  });
  const guards = (d) => {
    const { writers } = mapDevice(d);
    return Object.fromEntries(Object.entries(writers).map(([k, w]) => [k, guardOf(w, d)]));
  };
  const all = (g) => ({
    onoff: g,
    windowcoverings_state: g,
    dim: g,
    button: g,
    target_temperature: undefined,
  });
  assert.deepEqual(guards(device('socket')), all(undefined));
  assert.deepEqual(guards(device('valve')), all('valve'));
  assert.deepEqual(guards(device('other', 'sprinkler')), all('valve'));
  assert.deepEqual(guards(device('garagedoor')), all('garage'));
  assert.deepEqual(guards(device('socket', 'garagedoor')), all('garage'));
  assert.deepEqual(guards(device('homealarm')), all('alarm'));
  assert.deepEqual(guards(device('siren')), all('alarm'));
  assert.deepEqual(guards(device('lock')), all('lock-any'));
  assert.equal(guardOf({ base: 'onoff' }, { class: 'constructor' }), undefined);
  // The keys (external ids) are unchanged.
  assert.deepEqual(Object.keys(mapDevice(device('valve')).writers), Object.keys(all()));
});

test('locks and buttons', () => {
  const lock = mapped('Serrure entrée');
  assert.deepEqual(spec(lock.features.locked), [C.LOCK, T.LOCK.BINARY, undefined, 0, 1, false]);
  assert.equal(lock.features.locked.name, 'Serrure entrée');
  assert.equal(lock.read('locked'), 1);
  assert.deepEqual(lock.write('locked', 0), [['locked', false]]);
  assert.equal(guardOf(lock.result.writers.locked, lock.device), 'lock');

  const button = mapped('Bouton scène');
  assert.deepEqual(spec(button.features.button), [C.BUTTON, T.BUTTON.PUSH, undefined, 0, 1, false]);
  assert.equal(button.features.button.has_feedback, false);
  const reader = button.result.readers.find((r) => r.key === 'button');
  assert.equal(reader.event, true);
  assert.deepEqual(reader.read(button.device), { state: 1 });
  assert.deepEqual(button.write('button', 1), [['button', true]]);

  const remote = mapDevice({
    id: 'z',
    name: 'Interrupteur mural',
    capabilities: ['button.1', 'button.2'],
    capabilitiesObj: {
      'button.1': { setable: false, title: 'Haut' },
      'button.2': { setable: false, title: 'Bas' },
    },
  });
  assert.deepEqual(
    remote.features.map((f) => [f.key, f.type, f.read_only]),
    [
      ['button.1', T.BUTTON.CLICK, true],
      ['button.2', T.BUTTON.CLICK, true],
    ],
  );
});

test('read-only capabilities, unknown ones, devices with nothing to offer', () => {
  const readOnly = mapped('Plafonnier', (d) => {
    d.capabilitiesObj.onoff.setable = false;
    return d;
  });
  assert.equal(readOnly.features.onoff.read_only, true);
  assert.equal(readOnly.result.writers.onoff, undefined);

  const speaker = mapped('Enceinte salon');
  assert.equal(speaker.result.features.length, 0);
  assert.deepEqual(speaker.result.skipped, ['speaker_playing', 'volume_set', 'volume_mute']);

  const hueOnly = mapDevice({
    id: 'h',
    name: 'Ruban',
    class: 'light',
    capabilities: ['onoff', 'light_hue'],
    capabilitiesObj: { onoff: { value: true }, light_hue: { value: 0.2 } },
  });
  assert.deepEqual(
    hueOnly.features.map((f) => f.key),
    ['onoff'],
  );
  assert.deepEqual(hueOnly.skipped, ['light_hue']);

  const scaled = mapDevice({
    id: 's',
    name: 'Variateur',
    capabilities: ['dim'],
    capabilitiesObj: { dim: { min: 0, max: 255, value: 51 } },
  });
  assert.equal(scaled.features[0].category, C.SWITCH);
  assert.equal(scaled.features[0].type, T.SWITCH.DIMMER);
  assert.deepEqual(scaled.readers[0].read({ capabilitiesObj: { dim: { value: 51 } } }), {
    state: 20,
  });
  assert.deepEqual(scaled.writers.dim.write(50), [{ capabilityId: 'dim', value: 127.5 }]);
  assert.equal(mapDevice({ id: 'e', capabilities: 'nope' }).features.length, 0);
});
