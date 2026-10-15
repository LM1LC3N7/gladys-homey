// -----------------------------------------------------------------------------
// The whole integration, real HTTP client and real WebSocket, against the
// simulated Homey of test/helpers/homeyServer.js on 127.0.0.1 (never the
// network), with the SDK's fake Gladys. Real time: a few hundred ms.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { HomeyApp } from '../src/app.js';
import { ACTIONS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { KEY } from './helpers/fakeHomey.js';
import { homeyServer, waitFor } from './helpers/homeyServer.js';

test('a Homey Pro, end to end: devices, live states, commands, presses, test', async (t) => {
  const sim = await homeyServer();
  const gladys = createFakeGladys({ config: { homey_address: sim.url, api_key: KEY } });
  const app = new HomeyApp({ gladys, logger: createLogger({ level: 'silent' }) });
  registerHandlers(gladys, app);
  t.after(async () => {
    app.stop();
    await sim.close();
  });
  await gladys.connect();
  await waitFor(() => app.liveState === 'live');
  assert.equal(gladys.fake.discoveredDevices.length, 23);
  const [conn] = sim.connections;
  assert.equal(conn.subscribed.size, 24);
  assert.ok(sim.requests.every((r) => r.path.endsWith('/ping') || r.auth === `Bearer ${KEY}`));

  const named = (name) => gladys.fake.discoveredDevices.find((d) => d.name === name);
  const lamp = named('Lampe salon (Salon)');
  const button = named('Bouton scène (Salon)');
  await gladys.fake.deviceCreated(lamp);
  await gladys.fake.deviceCreated(button);
  const lampId = app.model.deviceIds.get(lamp.external_id);

  sim.emit(lampId, 'onoff', false);
  await waitFor(async () => {
    await app.publisher.flush();
    return gladys.fake.lastState(`${lamp.external_id}:onoff`) === 0;
  });

  const dim = lamp.features.find((f) => f.external_id.endsWith(':dim'));
  const ack = await gladys.fake.setValue(lamp, dim, 30);
  assert.equal(ack.success, true, ack.error);
  const put = sim.requests.filter((r) => r.method === 'PUT').at(-1);
  assert.equal(put.path, `/api/manager/devices/device/${lampId}/capability/dim`);
  assert.equal(JSON.parse(put.body).value, 0.3);
  await waitFor(async () => {
    await app.publisher.flush();
    return gladys.fake.lastState(`${lamp.external_id}:dim`) === 30;
  });

  const push = button.features[0];
  assert.equal((await gladys.fake.setValue(button, push, 1)).success, true);
  await waitFor(async () => {
    await app.publisher.flush();
    return (
      gladys.fake.states.filter((s) => s.device_feature_external_id === push.external_id).length ===
      1
    );
  });

  const tested = await gladys.fake.action(ACTIONS.TEST, {});
  assert.match(
    tested.data.message.en,
    /^Connection OK, Homey 12\.4\.1 at http:\/\/127\.0\.0\.1:\d+: 24 devices, 6 zones\. 23 devices offered in Discovery, 1 left out .+ Live updates: OK\.$/,
  );

  sim.drop();
  await waitFor(() => app.liveState === 'down');
  await waitFor(() => app.liveState === 'live', 8000); // opened again after 5 s
  assert.equal(sim.connections.length, 3, 'the app, the test, the app again');
});
