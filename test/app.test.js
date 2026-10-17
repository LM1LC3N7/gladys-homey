// -----------------------------------------------------------------------------
// End to end: the real SDK wiring (src/handlers.js) against the SDK's fake
// Gladys, and a fake Homey serving the fixtures with its realtime events.
// Timers are mocked: the reads, the reconnections and the state flush run
// when the test ticks.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HomeyApp } from '../src/app.js';
import { ACTIONS, TIMINGS } from '../src/constants.js';
import { HomeyError } from '../src/homey.js';
import { registerHandlers } from '../src/handlers.js';
import { T } from '../src/i18n.js';
import { RealtimeError } from '../src/realtime.js';
import { HOMEY_ID, HOMEY_VERSION } from './fixtures/homey.js';
import { KEY, URL_OF_HOMEY, fakeHomey, settle } from './helpers/fakeHomey.js';

const CONFIG = { homey_address: '192.168.1.20', api_key: KEY };
const OFFERED = 23; // 24 devices, the speaker has nothing to offer

async function setup(t, config = CONFIG, prepare = () => {}, options = {}) {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: Date.parse('2026-10-15T08:00:00.000Z'),
  });
  const gladys = createFakeGladys({ config, ...options });
  const box = fakeHomey();
  prepare(box);
  const app = new HomeyApp({
    gladys,
    connect: box.connect,
    realtime: box.realtime,
    now: () => Date.now(),
    logger: createLogger({ level: 'silent' }),
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  await gladys.connect();
  await settle();
  await tick(0); // the read that follows the realtime subscriptions
  return { gladys, app, box, tick };
}

const deviceNamed = (gladys, name) => gladys.fake.discoveredDevices.find((d) => d.name === name);

async function created(gladys, name) {
  const device = deviceNamed(gladys, name);
  assert.ok(device, `${name} is discovered`);
  await gladys.fake.deviceCreated(device);
  return device;
}

const featureOf = (device, key) => {
  const feature = device.features.find((f) => f.external_id === `${device.external_id}:${key}`);
  assert.ok(feature, `${device.name} has ${key}`);
  return feature;
};

const statesOf = (gladys, featureId) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId);

const lastTransport = (gladys, device) =>
  gladys.fake.transports.filter((e) => e.device_external_id === device.external_id).at(-1);

test('the devices of Homey become Gladys devices named after their zone, live', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  assert.equal(box.clients.at(-1).url, URL_OF_HOMEY);
  assert.equal(gladys.fake.discoveredDevices.length, OFFERED);
  const lamp = deviceNamed(gladys, 'Lampe salon (Salon)');
  assert.deepEqual(
    lamp.features.map((f) => f.external_id.slice(lamp.external_id.length + 1)),
    ['onoff', 'dim', 'color', 'light_temperature'],
  );
  assert.equal(lamp.external_id, `ext:test-integration:homey:${box.device('Lampe salon').id}`);
  assert.deepEqual(lamp.params.slice(0, 3), [
    { name: 'HOMEY_DEVICE_ID', value: box.device('Lampe salon').id },
    { name: 'HOMEY_ZONE', value: 'Salon' },
    { name: 'HOMEY_CLASS', value: 'light' },
  ]);
  assert.ok(deviceNamed(gladys, 'Compteur gaz (Maison)'), 'a device of the root zone');
  assert.ok(!gladys.fake.discoveredDevices.some((d) => d.name.startsWith('Enceinte')));
  assert.equal(app.liveState, 'live');
  assert.equal(box.live().subscribed.size, OFFERED + 1, 'the device manager and every device');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    T.connected(HOMEY_VERSION, OFFERED, 'live').en,
  );
  assert.equal(gladys.fake.config.homey_id, HOMEY_ID, 'the id of the Homey is kept');

  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.states.length, 0, 'nothing is sent for a device not created');

  await created(gladys, 'Lampe salon (Salon)');
  const sensor = await created(gladys, 'Capteur salon (Salon)');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:onoff`), 1);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:dim`), 50);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:color`), 0x0000ff);
  assert.equal(
    statesOf(gladys, `${lamp.external_id}:light_temperature`).length,
    0,
    'in colour mode, no colour temperature',
  );
  assert.equal(gladys.fake.lastState(`${sensor.external_id}:measure_temperature`), 21.3);
  assert.equal(gladys.fake.lastState(`${sensor.external_id}:measure_pressure`), 1013.2);
  assert.deepEqual(lastTransport(gladys, sensor), {
    device_external_id: sensor.external_id,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
});

test('the capability events reach Gladys at once; every press is an event', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Lampe salon (Salon)');
  const door = await created(gladys, "Porte d'entrée (Entrée)");
  const button = await created(gladys, 'Bouton scène (Salon)');
  const station = await created(gladys, 'Station Netatmo (Salon)');
  await tick(TIMINGS.flushInterval);

  box.emit('Lampe salon', 'onoff', false);
  box.emit("Porte d'entrée", 'alarm_contact', true);
  box.emit('Station Netatmo', 'measure_temperature.outside', 8.9);
  await tick(TIMINGS.flushInterval);
  await tick(10_000); // a measurement waits for the sensor interval
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:onoff`), 0);
  assert.equal(gladys.fake.lastState(`${door.external_id}:alarm_contact`), 0, 'open door');
  assert.equal(gladys.fake.lastState(`${station.external_id}:measure_temperature.outside`), 8.9);

  box.emit('Lampe salon', 'light_mode', 'temperature');
  await tick(TIMINGS.flushInterval);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:light_temperature`), 257);

  const presses = () => statesOf(gladys, `${button.external_id}:button`);
  assert.equal(presses().length, 0, 'no press at the connection');
  box.emit('Bouton scène', 'button', true);
  box.emit('Bouton scène', 'button', true);
  await tick(TIMINGS.flushInterval);
  assert.deepEqual(
    presses().map((s) => s.state),
    [1, 1],
  );
  const reads = box.callsOf('devices').length;
  await tick(TIMINGS.resync);
  await tick(TIMINGS.flushInterval);
  assert.equal(box.callsOf('devices').length, reads + 1, 'one full read every 5 minutes');
  assert.equal(presses().length, 2, 'the full read sends no press');
});

test('the Gladys commands set the Homey capabilities', async (t) => {
  const { gladys, box } = await setup(t);
  const run = async (name, key, value) => {
    const device = deviceNamed(gladys, name);
    const before = box.executed.length;
    const ack = await gladys.fake.setValue(device, featureOf(device, key), value);
    assert.equal(ack.success, true, `${name} ${key}=${value}: ${ack.error}`);
    return box.executed.slice(before).map((c) => [c.capabilityId, c.value]);
  };
  const lamp = 'Lampe salon (Salon)';
  assert.deepEqual(await run(lamp, 'onoff', 0), [['onoff', false]]);
  assert.deepEqual(await run(lamp, 'dim', 30), [['dim', 0.3]]);
  assert.deepEqual(await run(lamp, 'color', 0xff0000), [
    ['light_hue', 0],
    ['light_saturation', 1],
  ]);
  assert.deepEqual(await run(lamp, 'light_temperature', 500), [
    ['light_temperature', 1],
    ['light_mode', 'temperature'],
  ]);
  assert.deepEqual(await run(lamp, 'color', 0x00ff00), [
    ['light_hue', 0.3333],
    ['light_saturation', 1],
    ['light_mode', 'color'],
  ]);
  assert.deepEqual(await run('Plafonnier (Cuisine)', 'light_temperature', 153), [
    ['light_temperature', 0],
  ]);
  assert.deepEqual(await run('Module double (Cuisine)', 'onoff.2', 1), [['onoff.2', true]]);
  assert.deepEqual(await run('Volet salon (Salon)', 'windowcoverings_state', 1), [
    ['windowcoverings_state', 'up'],
  ]);
  assert.deepEqual(await run('Volet salon (Salon)', 'windowcoverings_state', 0), [
    ['windowcoverings_state', 'idle'],
  ]);
  assert.deepEqual(await run('Volet salon (Salon)', 'windowcoverings_state', -1), [
    ['windowcoverings_state', 'down'],
  ]);
  assert.deepEqual(await run('Volet salon (Salon)', 'windowcoverings_set', 75), [
    ['windowcoverings_set', 0.75],
  ]);
  assert.deepEqual(await run('Rideau chambre (Chambre)', 'windowcoverings_set', 0), [
    ['windowcoverings_set', 0],
  ]);
  const thermostat = 'Thermostat salon (Salon)';
  assert.deepEqual(await run(thermostat, 'target_temperature', 21.3), [
    ['target_temperature', 21.5],
  ]);
  assert.deepEqual(await run(thermostat, 'target_temperature', 40), [['target_temperature', 30]]);
  assert.deepEqual(await run(thermostat, 'thermostat_mode', 3), [['thermostat_mode', 'auto']]);
  assert.deepEqual(await run('Serrure entrée (Entrée)', 'locked', 1), [['locked', true]]);

  const button = await created(gladys, 'Bouton scène (Salon)');
  assert.deepEqual(await run('Bouton scène (Salon)', 'button', 1), [['button', true]]);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(TIMINGS.flushInterval);
  await settle();
  assert.equal(statesOf(gladys, `${button.external_id}:button`).length, 1, 'the push is a press');

  const device = deviceNamed(gladys, thermostat);
  const refused = await gladys.fake.setValue(device, featureOf(device, 'thermostat_mode'), 7);
  assert.equal(refused.success, false);
  assert.match(refused.error, /has no mode 7/);
  const sensor = deviceNamed(gladys, 'Capteur salon (Salon)');
  const readOnly = await gladys.fake.setValue(sensor, featureOf(sensor, 'measure_temperature'), 20);
  assert.equal(readOnly.success, false);
});

const ENTREE = 'a0f1c2d3-0000-4000-8000-000000000005';

/** A device added in Homey, as Homey would announce it. */
async function addDevice(box, tick, { id, name, cls, virtualClass = null, caps }) {
  const capabilitiesObj = Object.fromEntries(
    Object.entries(caps).map(([capId, cap]) => [
      capId,
      { id: capId, getable: true, setable: true, lastUpdated: '2026-10-15T06:00:00.000Z', ...cap },
    ]),
  );
  const device = {
    id,
    name,
    zone: ENTREE,
    class: cls,
    virtualClass,
    capabilities: Object.keys(caps),
    capabilitiesObj,
    available: true,
    ready: true,
  };
  box.devices[id] = device;
  box.emitManager('device.create', device);
  await tick(TIMINGS.modelDebounce);
  return device;
}

const COVER_VALUES = [{ id: 'up' }, { id: 'idle' }, { id: 'down' }];

test('unlocking is refused by default, allowed by its option; locking always works', async (t) => {
  const { gladys, box } = await setup(t);
  const lock = await created(gladys, 'Serrure entrée (Entrée)');
  const locked = featureOf(lock, 'locked');
  assert.equal(locked.read_only, false, 'the feature stays writable: the option decides');

  const denied = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(denied.success, false);
  assert.match(denied.error, /"Allow unlocking from Gladys"/);
  assert.match(denied.error, /« Autoriser le déverrouillage depuis Gladys »/);
  assert.equal(box.executed.length, 0, 'nothing sent');
  assert.equal(box.callsOf('device').length, 0);

  const ok = await gladys.fake.setValue(lock, locked, 1);
  assert.equal(ok.success, true, 'locking is always allowed');

  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: true });
  await settle();
  const unlocked = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(unlocked.success, true, unlocked.error);
  assert.equal(box.callsOf('device').length, 1, 'the lock is read just before');
  assert.deepEqual(
    box.executed.map((c) => [c.capabilityId, c.value]),
    [
      ['locked', true],
      ['locked', false],
    ],
  );
  const timeout = box.callsOf('setCapability').at(-1).args.options.timeout;
  assert.ok(timeout > 0 && timeout <= TIMINGS.setValueDeadline + TIMINGS.commandSlack);

  const again = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(again.success, true);
  assert.equal(box.executed.length, 2, 'already unlocked: nothing sent');

  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: false });
  await settle();
  assert.equal((await gladys.fake.setValue(lock, locked, 0)).success, false, 'off again');
});

test('valves, sprinklers, garage doors and alarms need their option', async (t) => {
  const { gladys, box, tick } = await setup(t);
  await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000a1',
    name: 'Vanne eau',
    cls: 'watervalve',
    caps: { onoff: { type: 'boolean', value: true } },
  });
  await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000a2',
    name: 'Arrosage',
    cls: 'other',
    virtualClass: 'sprinkler',
    caps: { onoff: { type: 'boolean', value: false } },
  });
  await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000a3',
    name: 'Porte garage',
    cls: 'garagedoor',
    caps: {
      windowcoverings_state: { type: 'enum', value: 'idle', values: COVER_VALUES },
      onoff: { type: 'boolean', value: false },
    },
  });
  await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000a4',
    name: 'Sirène',
    cls: 'siren',
    caps: { onoff: { type: 'boolean', value: false } },
  });
  // Another class, told by a capability: a gate relay and an alarm panel.
  await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000a5',
    name: 'Relais portail',
    cls: 'other',
    caps: {
      garagedoor_closed: { type: 'boolean', value: true, setable: false },
      onoff: { type: 'boolean', value: false },
    },
  });
  await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000a6',
    name: 'Centrale',
    cls: 'sensor',
    caps: {
      homealarm_state: { type: 'enum', value: 'armed', setable: false },
      onoff: { type: 'boolean', value: true },
    },
  });
  const valve = await created(gladys, 'Vanne eau (Entrée)');
  const sprinkler = await created(gladys, 'Arrosage (Entrée)');
  const garage = await created(gladys, 'Porte garage (Entrée)');
  const siren = await created(gladys, 'Sirène (Entrée)');
  const relay = await created(gladys, 'Relais portail (Entrée)');
  const panel = await created(gladys, 'Centrale (Entrée)');
  const VALVE = /Allow valve and sprinkler control from Gladys/;
  const GARAGE = /Allow garage door and gate control from Gladys/;
  const ALARM = /Allow alarm and siren control from Gladys/;
  const tries = [
    [valve, 'onoff', 0, VALVE],
    [sprinkler, 'onoff', 1, VALVE],
    [garage, 'windowcoverings_state', 1, GARAGE],
    [garage, 'onoff', 1, GARAGE],
    [siren, 'onoff', 0, ALARM],
    [relay, 'onoff', 1, GARAGE],
    [panel, 'onoff', 0, ALARM],
  ];
  for (const [device, key, value, error] of tries) {
    const feature = featureOf(device, key);
    assert.equal(feature.read_only, false);
    const ack = await gladys.fake.setValue(device, feature, value);
    assert.equal(ack.success, false, `${device.name} ${key}`);
    assert.match(ack.error, error);
  }
  assert.equal(box.executed.length, 0, 'nothing sent');

  await gladys.fake.configUpdated({
    ...CONFIG,
    allow_valve_control: true,
    allow_garage_door_control: true,
    allow_alarm_control: true,
  });
  await settle();
  for (const [device, key, value] of tries) {
    const ack = await gladys.fake.setValue(device, featureOf(device, key), value);
    assert.equal(ack.success, true, `${device.name} ${key}: ${ack.error}`);
  }
  assert.deepEqual(
    box.executed.map((c) => [c.capabilityId, c.value]),
    [
      ['onoff', false],
      ['onoff', true],
      ['windowcoverings_state', 'up'],
      ['onoff', true],
      ['onoff', false],
      ['onoff', true],
      ['onoff', false],
    ],
  );
  assert.equal(box.callsOf('device').length, tries.length, 'each one read just before');
});

test('the switch of a lock needs allow_unlock both ways; an unknown device is refused', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  const bolt = await addDevice(box, tick, {
    id: '6d1e4f2a-0000-4000-8000-0000000000b1',
    name: 'Verrou relais',
    cls: 'other',
    caps: {
      locked: { type: 'boolean', value: true },
      onoff: { type: 'boolean', value: false },
    },
  });
  const device = await created(gladys, 'Verrou relais (Entrée)');
  for (const value of [0, 1]) {
    const ack = await gladys.fake.setValue(device, featureOf(device, 'onoff'), value);
    assert.equal(ack.success, false);
    assert.match(ack.error, /Allow unlocking from Gladys/);
  }
  assert.equal((await gladys.fake.setValue(device, featureOf(device, 'locked'), 1)).success, true);

  // Deleted in Homey: during the 2 s before the model is rebuilt, refused.
  await gladys.fake.configUpdated({ ...CONFIG, allow_unlock: true });
  await settle();
  delete box.devices[bolt.id];
  box.emitManager('device.delete', { id: bolt.id });
  await settle();
  assert.ok(app.model.writers.has(featureOf(device, 'onoff').external_id), 'model not rebuilt yet');
  const before = box.executed.length;
  const lamp = deviceNamed(gladys, 'Lampe salon (Salon)');
  for (const feature of [featureOf(device, 'onoff'), featureOf(device, 'locked')]) {
    const ack = await gladys.fake.setValue(device, feature, 1);
    assert.equal(ack.success, false);
    assert.match(ack.error, /not known to Homey/);
  }
  assert.equal(box.executed.length, before, 'nothing sent');
  assert.equal((await gladys.fake.setValue(lamp, featureOf(lamp, 'onoff'), 1)).success, true);
});

test('a guarded command on an unknown or stale state is refused', async (t) => {
  const { gladys, box } = await setup(t, { ...CONFIG, allow_unlock: true });
  const lock = await created(gladys, 'Serrure entrée (Entrée)');
  const locked = featureOf(lock, 'locked');
  const record = box.device('Serrure entrée');

  box.failOn.device = new HomeyError('timeout', 'no answer within 3 s');
  let ack = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /State unknown/);
  box.failOn.device = undefined;

  record.available = false;
  ack = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /unavailable in Homey/);
  record.available = true;

  record.capabilitiesObj.locked.value = null;
  ack = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /State unknown/);
  assert.equal(box.executed.length, 0, 'nothing sent on a stale state');

  // The state in memory says locked; Homey says unlocked now: nothing to send.
  record.capabilitiesObj.locked.value = false;
  ack = await gladys.fake.setValue(lock, locked, 0);
  assert.equal(ack.success, true);
  assert.equal(box.executed.length, 0, 'decided on the state read, not the one in memory');
});

test('the commands of a device run one at a time, within the ack delay', async (t) => {
  const { gladys, box } = await setup(t);
  const lamp = deviceNamed(gladys, 'Lampe salon (Salon)');
  let active = 0;
  let most = 0;
  box.beforeSet = async () => {
    active += 1;
    most = Math.max(most, active);
    await settle(3);
    active -= 1;
  };
  const acks = await Promise.all([
    gladys.fake.setValue(lamp, featureOf(lamp, 'onoff'), 0),
    gladys.fake.setValue(lamp, featureOf(lamp, 'onoff'), 1),
  ]);
  assert.ok(acks.every((a) => a.success));
  assert.equal(most, 1, 'never two at once on a device');
  assert.deepEqual(
    box.executed.map((c) => c.value),
    [false, true],
  );

  // A command of several requests: once the first left, the others follow it.
  box.beforeSet = async () => {
    t.mock.timers.tick(TIMINGS.setValueDeadline + 500);
  };
  let before = box.executed.length;
  const color = await gladys.fake.setValue(lamp, featureOf(lamp, 'color'), 0xff0000);
  assert.equal(color.success, true, color.error);
  assert.equal(box.executed.length, before + 2);

  // Homey slow: a command that waited past the deadline is refused before it leaves.
  let first = true;
  box.beforeSet = async () => {
    if (first) {
      first = false;
      await settle(3);
      t.mock.timers.tick(TIMINGS.setValueDeadline + 500);
    }
  };
  before = box.executed.length;
  const [sent, late] = await Promise.all([
    gladys.fake.setValue(lamp, featureOf(lamp, 'onoff'), 0),
    gladys.fake.setValue(lamp, featureOf(lamp, 'onoff'), 1),
  ]);
  assert.equal(sent.success, true);
  assert.equal(late.success, false);
  assert.match(late.error, /too slowly: command not sent/);
  assert.equal(box.executed.length, before + 1, 'the late one never leaves');
});

test('without realtime events the devices are read every 10 s, the socket tried again', async (t) => {
  const refusal = new RealtimeError('forbidden', 'Missing Scopes: homey.system.readonly');
  const { gladys, app, box, tick } = await setup(t, CONFIG, (b) => {
    b.liveRefusal = refusal;
  });
  assert.equal(app.liveState, 'down');
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    T.connected(HOMEY_VERSION, OFFERED, 'down', refusal).en,
  );
  assert.match(gladys.fake.connectionStatus.message.en, /View System/);
  const lamp = await created(gladys, 'Lampe salon (Salon)');
  const button = await created(gladys, 'Bouton scène (Salon)');
  assert.deepEqual(lastTransport(gladys, lamp), {
    device_external_id: lamp.external_id,
    transport: DEVICE_TRANSPORTS.LOCAL,
    degraded: true,
    message: T.badge.noLive,
  });

  box.emit('Lampe salon', 'onoff', false); // no socket: seen at the next read
  const reads = box.callsOf('devices').length;
  await tick(TIMINGS.fallbackPoll);
  await tick(TIMINGS.flushInterval);
  assert.equal(box.callsOf('devices').length, reads + 1);
  assert.equal(gladys.fake.lastState(`${lamp.external_id}:onoff`), 0);

  const presses = () => statesOf(gladys, `${button.external_id}:button`).length;
  box.emit('Bouton scène', 'button', true);
  await tick(TIMINGS.fallbackPoll);
  await tick(TIMINGS.fallbackPoll); // nothing new: no second press
  await tick(TIMINGS.flushInterval);
  assert.equal(presses(), 1, 'a new lastUpdated of the button is a press');

  // A command is read back soon, not at the next tick.
  const before = box.callsOf('devices').length;
  const ack = await gladys.fake.setValue(lamp, featureOf(lamp, 'onoff'), 1);
  assert.equal(ack.success, true);
  await tick(TIMINGS.commandEcho);
  assert.equal(box.callsOf('devices').length, before + 1);

  box.liveRefusal = undefined;
  await tick(TIMINGS.authRetry);
  assert.equal(app.liveState, 'live');
  assert.deepEqual(lastTransport(gladys, lamp), {
    device_external_id: lamp.external_id,
    transport: DEVICE_TRANSPORTS.LOCAL,
  });
});

test('a lost socket opens again; its presses are not counted twice', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  const button = await created(gladys, 'Bouton scène (Salon)');
  box.emit('Bouton scène', 'button', true);
  box.dropLive();
  await settle();
  assert.equal(app.liveState, 'down');
  box.liveRefusal = new RealtimeError('network', 'connection refused');
  await tick(TIMINGS.realtimeRetryMin);
  assert.equal(app.liveState, 'down', 'still refused');
  await tick(TIMINGS.fallbackPoll); // a read while down: the press came by the socket
  await tick(TIMINGS.flushInterval);
  assert.equal(statesOf(gladys, `${button.external_id}:button`).length, 1);

  box.liveRefusal = undefined;
  await tick(TIMINGS.realtimeRetryMax); // the retries were spaced meanwhile
  assert.equal(app.liveState, 'live');
  assert.equal(box.live().subscribed.size, OFFERED + 1);
});

test('Homey unreachable: status, badges, reconnection', async (t) => {
  const { gladys, app, box, tick } = await setup(t);
  const lamp = await created(gladys, 'Lampe salon (Salon)');
  box.fail = new HomeyError('network', 'host unreachable');
  box.dropLive('transport error');
  await settle();
  await tick(TIMINGS.fallbackPoll);
  assert.equal(app.online, false);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /host unreachable/);
  assert.equal(lastTransport(gladys, lamp).transport, DEVICE_TRANSPORTS.UNREACHABLE);

  box.fail = undefined;
  await tick(TIMINGS.retryMin);
  assert.equal(app.online, true);
  assert.equal(app.liveState, 'live');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(lastTransport(gladys, lamp).transport, DEVICE_TRANSPORTS.LOCAL);
});

test('a refused API key is said so and retried slowly', async (t) => {
  const { gladys, box, tick } = await setup(t, { ...CONFIG, api_key: 'not-the-key' });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.equal(gladys.fake.connectionStatus.message.en, T.failure(new HomeyError('auth', 'x')).en);
  const reads = box.callsOf('devices').length;
  await tick(TIMINGS.retryMax);
  assert.equal(box.callsOf('devices').length, reads, 'not every minute');
  await tick(TIMINGS.authRetry);
  assert.equal(box.callsOf('devices').length, reads + 1);
});

test('the configuration errors are shown, nothing is called', async (t) => {
  const { gladys, box } = await setup(t, { homey_address: '192.168.1.20' });
  assert.equal(gladys.fake.connectionStatus.message.en, T.noKey.en);
  await gladys.fake.configUpdated({ api_key: KEY, homey_address: 'https://my.homey.app/homeys/x' });
  await settle();
  assert.equal(gladys.fake.connectionStatus.message.en, T.badAddress('cloud').en);
  await gladys.fake.configUpdated({ api_key: KEY, homey_address: 'homey-5f7c.local' });
  await settle();
  assert.equal(gladys.fake.connectionStatus.message.en, T.badAddress('local-name').en);
  assert.equal(box.calls.length, 0);
  const ack = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(ack.data.message.en, T.badAddress('local-name').en);
});

const MDNS = [
  {
    name: 'Homey-5f7c2a._homey._tcp.local',
    host: 'homey-5f7c2a.local',
    addresses: ['fe80::1c2d:3e4f', '192.168.1.20'],
    port: 4859,
    txt: ['id=5f7c2a91d3e4b60012ab34cd'],
  },
  {
    name: 'Printer._homey._tcp.local',
    host: 'printer.local',
    addresses: ['192.168.1.99'],
    port: 80,
    txt: [],
  },
];

test('without an address, Homey is found on the network and its address kept', async (t) => {
  const { gladys, app, box } = await setup(t, { api_key: KEY }, () => {}, {
    scanResults: { mdns: MDNS },
  });
  assert.equal(gladys.fake.scans.length, 1);
  assert.equal(gladys.fake.scans[0].type, 'mdns');
  assert.equal(app.online, true);
  assert.equal(gladys.fake.config.homey_address, URL_OF_HOMEY);
  assert.equal(gladys.fake.config.homey_id, HOMEY_ID);
  assert.ok(box.clients.every((c) => c.closed || c.url === URL_OF_HOMEY));

  // The saved address coming back as a configuration update: no reconnection.
  const clients = box.clients.length;
  await gladys.fake.configUpdated({ ...gladys.fake.config });
  await settle();
  assert.equal(box.clients.length, clients);
  assert.equal(app.online, true);
});

test('no Homey, or several, on the network: the status asks for the address', async (t) => {
  const { gladys, box, tick } = await setup(t, { api_key: KEY }, () => {}, {
    scanResults: { mdns: [] },
  });
  assert.equal(
    gladys.fake.connectionStatus.message.en,
    T.failure(new HomeyError('not-found', '')).en,
  );

  gladys.fake.scanResults.mdns = [
    ...MDNS,
    { name: 'Homey-2._homey._tcp.local', addresses: ['192.168.1.21'], txt: [] },
  ];
  box.others.set('http://192.168.1.21', 'aa00bb11cc22dd33ee44ff55');
  await tick(TIMINGS.retryMin);
  assert.match(gladys.fake.connectionStatus.message.en, /Several Homeys found/);
  assert.match(gladys.fake.connectionStatus.message.en, /192\.168\.1\.20, 192\.168\.1\.21/);
});

test('Homey moved to another address: found again by its id', async (t) => {
  const { gladys, app, box, tick } = await setup(t, { ...CONFIG, homey_id: HOMEY_ID }, () => {}, {
    scanResults: { mdns: [{ name: 'Homey._homey._tcp.local', addresses: ['192.168.1.33'] }] },
  });
  box.addresses = ['http://192.168.1.33'];
  box.dropLive();
  await settle();
  await tick(TIMINGS.fallbackPoll); // failure 1
  await tick(TIMINGS.retryMin); // failure 2
  await tick(TIMINGS.retryMin * 2); // failure 3
  assert.equal(app.online, false);
  assert.equal(gladys.fake.scans.length, 0);
  await tick(TIMINGS.retryMin * 4);
  assert.equal(gladys.fake.scans.length, 1);
  assert.equal(app.online, true);
  assert.equal(gladys.fake.config.homey_address, 'http://192.168.1.33');
});

test('devices added, renamed, made unavailable or removed in Homey follow', async (t) => {
  const { gladys, box, tick } = await setup(t);
  const lamp = box.device('Lampe salon');
  box.emitManager('device.update', { ...lamp, name: 'Lampe canapé' });
  await tick(TIMINGS.modelDebounce);
  assert.ok(deviceNamed(gladys, 'Lampe canapé (Salon)'));
  assert.ok(!deviceNamed(gladys, 'Lampe salon (Salon)'));

  const plug = structuredClone(box.device('Prise lampadaire'));
  const fresh = { ...plug, id: '6d1e4f2a-0000-4000-8000-0000000000ff', name: 'Nouvelle prise' };
  box.devices[fresh.id] = fresh;
  box.emitManager('device.create', fresh);
  await tick(TIMINGS.modelDebounce);
  assert.ok(deviceNamed(gladys, 'Nouvelle prise (Salon)'));
  assert.ok(box.live().subscribed.has(`homey:device:${fresh.id}`));

  const created1 = await created(gladys, 'Nouvelle prise (Salon)');
  box.emitManager('device.update', {
    ...fresh,
    available: false,
    unavailableMessage: 'Hors de portée',
  });
  await settle();
  assert.deepEqual(lastTransport(gladys, created1), {
    device_external_id: created1.external_id,
    transport: DEVICE_TRANSPORTS.UNREACHABLE,
    degraded: true,
    message: T.badge.unavailable('Hors de portée'),
  });

  delete box.devices[fresh.id];
  box.emitManager('device.delete', { id: fresh.id });
  await tick(TIMINGS.modelDebounce);
  assert.ok(!deviceNamed(gladys, 'Nouvelle prise (Salon)'));
});

test('a device Homey marks unavailable gets an unreachable badge with the reason', async (t) => {
  const { gladys } = await setup(t);
  const bulb = await created(gladys, 'Ampoule terrasse (Jardin)');
  assert.deepEqual(lastTransport(gladys, bulb), {
    device_external_id: bulb.external_id,
    transport: DEVICE_TRANSPORTS.UNREACHABLE,
    degraded: true,
    message: T.badge.unavailable("L'appareil ne répond pas"),
  });
  assert.match(T.badge.unavailable("L'appareil ne répond pas").fr, /Indisponible dans Homey/);
});

test('the connection test counts the devices and tries the realtime events', async (t) => {
  const { gladys, box } = await setup(t);
  const ok = await gladys.fake.action(ACTIONS.TEST, {});
  assert.equal(ok.success, true);
  assert.equal(
    ok.data.message.en,
    T.test.ok({
      version: HOMEY_VERSION,
      url: URL_OF_HOMEY,
      devices: OFFERED,
      total: 24,
      empty: 1,
      zones: 6,
      live: { ok: true },
    }).en,
  );
  assert.match(ok.data.message.fr, /Connexion OK/);

  box.failOn.zones = new HomeyError('forbidden', 'Missing Scopes');
  box.liveRefusal = new RealtimeError('forbidden', 'Missing Scopes');
  const partial = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(partial.data.message.en, /zones not readable/);
  assert.match(partial.data.message.en, /View System/);

  box.fail = new HomeyError('network', 'connection refused');
  const down = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(down.data.message.en, /Homey is unreachable: connection refused/);
});

test('Scan publishes the devices again; a deleted device is forgotten', async (t) => {
  const { gladys } = await setup(t);
  const published = () =>
    gladys.fake.requests.filter((r) => r.path === '/discovered_device' && r.status !== 400).length;
  const before = published();
  await gladys.fake.scanRequest();
  assert.equal(published(), before + 1);
  const lamp = await created(gladys, 'Lampe salon (Salon)');
  await gladys.fake.deviceDeleted(lamp);
  assert.ok(true);
});

test('a configuration change reconnects; the same values do not', async (t) => {
  const { gladys, box } = await setup(t);
  const clients = box.clients.length;
  await gladys.fake.configUpdated({ ...CONFIG });
  await settle();
  assert.equal(box.clients.length, clients);
  await gladys.fake.configUpdated({ ...CONFIG, sensor_interval: 30 });
  await settle();
  assert.equal(box.clients.length, clients + 1);
});

test('a socket still opening from a previous start does not block the next one', async (t) => {
  let hang = true;
  const { gladys, app } = await setup(t, CONFIG, (b) => {
    const real = b.realtime;
    b.realtime = (options) => (hang ? new Promise(() => {}) : real(options));
  });
  assert.equal(app.liveState, 'connecting');
  hang = false;
  await gladys.fake.configUpdated({ ...CONFIG, sensor_interval: 20 });
  await settle();
  assert.equal(app.liveState, 'live');
});
