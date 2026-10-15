// -----------------------------------------------------------------------------
// The realtime socket: the Socket.IO 2 packets, then the real WebSocket of
// Node.js against the simulated Homey of test/helpers/homeyServer.js
// (127.0.0.1 only, never the network).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  PACKET,
  RealtimeError,
  decodePacket,
  encodePacket,
  openRealtime,
  refusal,
} from '../src/realtime.js';
import { HOMEY_ID, answers, deviceNamed } from './fixtures/homey.js';
import { KEY } from './helpers/fakeHomey.js';
import { homeyServer, waitFor } from './helpers/homeyServer.js';

test('the packets: encoded like socket.io-client 2', () => {
  assert.equal(
    encodePacket({
      type: PACKET.EVENT,
      id: 0,
      data: ['handshakeClient', { token: 'k', homeyId: 'h' }],
    }),
    '420["handshakeClient",{"token":"k","homeyId":"h"}]',
  );
  assert.equal(encodePacket({ type: PACKET.CONNECT, nsp: '/api' }), '40/api,');
  assert.equal(
    encodePacket({
      type: PACKET.EVENT,
      nsp: '/api',
      id: 12,
      data: ['subscribe', 'homey:manager:devices'],
    }),
    '42/api,12["subscribe","homey:manager:devices"]',
  );
});

test('the packets: decoded like socket.io-parser 3', () => {
  assert.deepEqual(decodePacket('0'), { type: 0, nsp: '/', id: undefined, data: undefined });
  assert.deepEqual(decodePacket('0/api,'), {
    type: 0,
    nsp: '/api',
    id: undefined,
    data: undefined,
  });
  assert.deepEqual(decodePacket('0/api'), { type: 0, nsp: '/api', id: undefined, data: undefined });
  assert.deepEqual(decodePacket('3/api,12[null]'), { type: 3, nsp: '/api', id: 12, data: [null] });
  assert.deepEqual(decodePacket('30[null,{"namespace":"/api"}]'), {
    type: 3,
    nsp: '/',
    id: 0,
    data: [null, { namespace: '/api' }],
  });
  assert.deepEqual(decodePacket('2/api,["homey:device:x","capability",{"value":1}]').data, [
    'homey:device:x',
    'capability',
    { value: 1 },
  ]);
  assert.deepEqual(decodePacket('4/api,"Not authorized"').data, 'Not authorized');
  assert.equal(decodePacket('51-["x",{"_placeholder":true,"num":0}]').type, PACKET.BINARY_EVENT);
  assert.equal(decodePacket('9'), undefined);
  assert.equal(decodePacket('2[oops'), undefined);
  assert.equal(decodePacket('5["no-dash"]'), undefined);
});

test('the refusals: 401 is the key, 403 a permission', () => {
  const auth = refusal({
    statusCode: 401,
    error: 'invalid_token',
    error_description: 'Invalid token',
  });
  assert.deepEqual([auth.kind, auth.message], ['auth', 'Invalid token']);
  assert.equal(refusal({ code: 403, message: 'Missing Scopes' }).kind, 'forbidden');
  assert.deepEqual(
    [refusal('Not authorized').kind, refusal('Not authorized').message],
    ['refused', 'Not authorized'],
  );
  assert.equal(refusal(undefined).message, 'refused by Homey');
});

test('a session: handshake, namespace, subscriptions, capability events, pings', async (t) => {
  const sim = await homeyServer();
  t.after(() => sim.close());
  sim.pingInterval = 50;
  const events = [];
  const closes = [];
  const session = await openRealtime({
    url: sim.url,
    token: KEY,
    homeyId: HOMEY_ID,
    onEvent: (...args) => events.push(args),
    onClose: (reason) => closes.push(reason),
  });
  const lamp = deviceNamed(answers().devices, 'Lampe salon');
  await session.subscribe('homey:manager:devices');
  await session.subscribe(`homey:device:${lamp.id}`);
  const [conn] = sim.connections;
  assert.equal(conn.namespace, '/api');
  assert.deepEqual([...conn.subscribed], ['homey:manager:devices', `homey:device:${lamp.id}`]);
  assert.match(
    conn.received[0],
    /^420\["handshakeClient",\{"token":".+","homeyId":"5f7c2a91d3e4b60012ab34cd"\}\]$/,
  );

  sim.emit(lamp.id, 'onoff', false);
  await waitFor(() => events.length === 1);
  assert.equal(events[0][0], `homey:device:${lamp.id}`);
  assert.equal(events[0][1], 'capability');
  assert.equal(events[0][2].capabilityId, 'onoff');
  assert.equal(events[0][2].value, false);

  await waitFor(() => sim.pings >= 2);
  session.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(closes, [], 'close() is not a loss');
});

test('a wrong key is refused at the handshake', async (t) => {
  const sim = await homeyServer();
  t.after(() => sim.close());
  await assert.rejects(
    openRealtime({ url: sim.url, token: 'wrong', homeyId: HOMEY_ID }),
    (err) => err instanceof RealtimeError && err.kind === 'auth' && err.message === 'Invalid token',
  );
});

test('a socket lost by Homey is reported once; a dead one by its pings', async (t) => {
  const sim = await homeyServer();
  t.after(() => sim.close());
  const closes = [];
  await openRealtime({
    url: sim.url,
    token: KEY,
    homeyId: HOMEY_ID,
    onClose: (r) => closes.push(r),
  });
  sim.drop();
  await waitFor(() => closes.length === 1);
  assert.match(closes[0], /^connection (closed|lost)$/);

  sim.pingInterval = 30;
  sim.pingTimeout = 60;
  sim.answerPings = false;
  const silent = [];
  await openRealtime({
    url: sim.url,
    token: KEY,
    homeyId: HOMEY_ID,
    onClose: (r) => silent.push(r),
  });
  await waitFor(() => silent.length === 1);
  assert.equal(silent[0], 'no answer to the ping');
});

test('nothing listening, or a socket that never speaks', async (t) => {
  const sim = await homeyServer();
  const url = sim.url;
  await sim.close();
  await assert.rejects(
    openRealtime({ url, token: KEY, homeyId: HOMEY_ID }),
    (err) => err instanceof RealtimeError && err.kind === 'network',
  );

  const mute = await homeyServer();
  t.after(() => mute.close());
  mute.mute = true;
  await assert.rejects(
    openRealtime({ url: mute.url, token: KEY, homeyId: HOMEY_ID, timeout: 200 }),
    (err) => err instanceof RealtimeError && err.kind === 'timeout',
  );

  const plain = http.createServer((req, res) => res.end('hello'));
  await new Promise((resolve) => plain.listen(0, '127.0.0.1', resolve));
  t.after(() => plain.close());
  await assert.rejects(
    openRealtime({
      url: `http://127.0.0.1:${plain.address().port}`,
      token: KEY,
      homeyId: HOMEY_ID,
    }),
    (err) => err instanceof RealtimeError && err.kind === 'network',
  );
});

test('a socket that cannot be built is a network refusal', async () => {
  class Broken {
    constructor() {
      throw new Error('bad url');
    }
  }
  await assert.rejects(
    openRealtime({ url: 'http://x', token: KEY, homeyId: HOMEY_ID, WebSocket: Broken }),
    (err) => err.kind === 'network' && err.message === 'bad url',
  );
});
