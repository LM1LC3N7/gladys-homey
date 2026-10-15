import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, deviceName } from '../src/devices.js';
import { bestAddress, homeyCandidates } from '../src/discovery.js';
import { asList, buildInventory, zoneNames } from '../src/inventory.js';
import { answers } from './fixtures/homey.js';

const idsOf = (id) => {
  const device = `ext:test:homey:${id}`;
  return { device, feature: (key) => `${device}:${key}` };
};

test('the inventory: every device with the name of its zone, sorted', () => {
  const { devices, zones } = answers();
  const inventory = buildInventory({ devices, zones });
  assert.equal(inventory.devices.length, 24);
  assert.equal(inventory.zones, 6);
  const lamp = inventory.devices.find((d) => d.name === 'Lampe salon');
  assert.equal(lamp.zone, 'Salon');
  assert.equal(inventory.devices.find((d) => d.name === 'Compteur gaz').zone, 'Maison');
  const names = inventory.devices.map((d) => d.name);
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b)),
  );

  const bare = buildInventory({ devices, zones: undefined });
  assert.equal(bare.devices[0].zone, undefined, 'no zones permission: bare names');
  const old = buildInventory({
    devices: [{ id: 'a', name: ' X ', zoneName: 'Garage' }, { id: 1 }, null],
  });
  assert.deepEqual(
    old.devices.map((d) => [d.name, d.zone]),
    [['X', 'Garage']],
  );
  assert.equal(
    buildInventory({ devices: [{ id: 'abcdef123456' }] }).devices[0].name,
    'Homey abcdef12',
  );
  assert.deepEqual(asList(undefined), []);
  assert.deepEqual([...zoneNames({ a: { id: 'a', name: '' } }).keys()], []);
});

test('the model: one Gladys device per Homey device, routing tables', () => {
  const { devices, zones } = answers();
  const inventory = buildInventory({ devices, zones });
  const model = buildModel(idsOf, inventory);
  assert.equal(model.devices.length, 23);
  assert.deepEqual(model.counts, { devices: 24, empty: 1, overflow: 0, skipped: 3 });
  const lamp = inventory.devices.find((d) => d.name === 'Lampe salon');
  const device = model.devices.find((d) => d.external_id === `ext:test:homey:${lamp.id}`);
  assert.equal(device.name, 'Lampe salon (Salon)');
  assert.equal(device.should_poll, false);
  assert.deepEqual(device.params, [
    { name: 'HOMEY_DEVICE_ID', value: lamp.id },
    { name: 'HOMEY_ZONE', value: 'Salon' },
    { name: 'HOMEY_CLASS', value: 'light' },
    { name: 'HOMEY_DRIVER', value: 'homey:app:com.philips.hue.zigbee:LCT015' },
  ]);
  assert.equal(model.deviceIds.get(device.external_id), lamp.id);
  assert.equal(model.owners.get(`${device.external_id}:color`), lamp.id);
  assert.ok(model.writers.has(`${device.external_id}:dim`));
  assert.deepEqual(
    model.readers.get(lamp.id).map((r) => r.featureId.split(':').pop()),
    ['onoff', 'dim', 'color', 'light_temperature'],
  );
  assert.ok(model.throttled.size > 20);
  const plug = inventory.devices.find((d) => d.name === 'Prise lampadaire');
  const plugDevice = model.devices.find((d) => d.external_id.endsWith(plug.id));
  assert.equal(plugDevice.params.find((p) => p.name === 'HOMEY_CLASS').value, 'light');
});

test('names: the zone in brackets, 100 characters at most', () => {
  assert.equal(deviceName({ name: 'Lampe', zone: 'Salon' }), 'Lampe (Salon)');
  assert.equal(deviceName({ name: 'Lampe' }), 'Lampe');
  assert.equal(deviceName({ name: 'x'.repeat(120), zone: 'Salon' }).length, 100);
});

test('mDNS results -> the addresses to try, IPv4 first', () => {
  assert.equal(bestAddress(['fe80::1', '192.168.1.20']), '192.168.1.20');
  assert.equal(bestAddress(['fe80::1', '2a01:cb00::5']), '2a01:cb00::5');
  assert.equal(bestAddress(['fe80::1', '::1']), undefined);
  assert.equal(bestAddress('nope'), undefined);
  assert.deepEqual(
    homeyCandidates([
      { name: 'Homey-5f7c._homey._tcp.local', addresses: ['192.168.1.20'], port: 4859, txt: [] },
      { name: 'Homey-5f7c._homey._tcp.local', addresses: ['192.168.1.20'] },
      { name: 'Homey-v6._homey._tcp.local', addresses: ['2a01:cb00::5'] },
      { name: 'Nothing', addresses: [] },
      null,
    ]),
    [
      { url: 'http://192.168.1.20', name: 'Homey-5f7c' },
      { url: 'http://[2a01:cb00::5]', name: 'Homey-v6' },
    ],
  );
  assert.deepEqual(homeyCandidates(undefined), []);
});
