import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { StatePublisher } from '../src/publisher.js';

const silent = { warn() {}, debug() {}, info() {}, error() {} };

function publisher({ budget, interval = 0, throttled = [] } = {}) {
  let now = 1_000_000;
  const gladys = createFakeGladys();
  const p = new StatePublisher({ gladys, logger: silent, now: () => now, budget });
  p.configure({ intervalSeconds: interval, throttled: new Set(throttled) });
  return { gladys, p, advance: (ms) => (now += ms) };
}

const id = (n) => `ext:test-integration:homey:${n}:measure_power`;

test('only the last value of a feature is sent', async () => {
  const { gladys, p } = publisher();
  p.push(id(1), { state: 1 });
  p.push(id(1), { state: 2 });
  p.push(id(2), { text: 'hello' });
  assert.equal(await p.flush(), 2);
  assert.deepEqual(
    gladys.fake.states.map((s) => [s.device_feature_external_id, s.state ?? s.text]),
    [
      [id(1), 2],
      [id(2), 'hello'],
    ],
  );
});

test('two presses in a row are two events, never merged nor skipped', async () => {
  const { gladys, p } = publisher();
  p.pushEvent(id(3), { state: 1 });
  p.pushEvent(id(3), { state: 1 });
  assert.equal(await p.flush(), 2);
  assert.equal(gladys.fake.states.filter((s) => s.device_feature_external_id === id(3)).length, 2);
});

test('the per-minute budget holds the rest for later', async () => {
  const { gladys, p, advance } = publisher({ budget: 3 });
  for (let i = 0; i < 5; i += 1) {
    p.push(id(i), { state: i });
  }
  assert.equal(await p.flush(), 3);
  assert.equal(await p.flush(), 0, 'budget spent');
  advance(60_000);
  assert.equal(await p.flush(), 2);
  assert.equal(gladys.fake.states.length, 5);
});

test('throttled features wait for the interval, the others do not', async () => {
  const { gladys, p, advance } = publisher({ interval: 10, throttled: [id(1)] });
  p.push(id(1), { state: 1 });
  p.push(id(2), { state: 1 });
  await p.flush();
  p.push(id(1), { state: 2 });
  p.push(id(2), { state: 2 });
  await p.flush();
  assert.equal(gladys.fake.lastState(id(1)), 1);
  assert.equal(gladys.fake.lastState(id(2)), 2);
  advance(10_000);
  await p.flush();
  assert.equal(gladys.fake.lastState(id(1)), 2);
});

test('a failed request keeps the values, unless a newer one arrived', async (t) => {
  const { gladys, p } = publisher();
  t.mock.method(gladys, 'publishChangedStates', async () => {
    throw new Error('429');
  });
  p.push(id(1), { state: 1 });
  await assert.rejects(p.flush(), /429/);
  assert.deepEqual(p.pending.get(id(1)), { state: 1 });
  p.forget('ext:test-integration:homey:1');
  assert.equal(p.pending.size, 0);
});
