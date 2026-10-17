// -----------------------------------------------------------------------------
// The client of the Homey local Web API: the answers, the errors, the
// requests it sends. A scripted `request`, then loopback HTTP servers
// (127.0.0.1 only, never the network) for the transport itself.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  HomeyError,
  createClient,
  homeyOf,
  httpRequest,
  networkError,
  parseAnswer,
} from '../src/homey.js';
import { HOMEY_ID, HOMEY_VERSION } from './fixtures/homey.js';
import { KEY } from './helpers/fakeHomey.js';
import { homeyServer } from './helpers/homeyServer.js';

const kindOf = (answer) => {
  try {
    parseAnswer(answer);
  } catch (err) {
    assert.ok(err instanceof HomeyError);
    return [err.kind, err.message];
  }
  return undefined;
};

test('parseAnswer: JSON, empty answers, and the errors Homey gives', () => {
  assert.deepEqual(parseAnswer({ status: 200, body: '{"a":1}' }), { a: 1 });
  assert.equal(parseAnswer({ status: 204, body: '' }), undefined);
  assert.deepEqual(
    kindOf({ status: 401, body: '{"error":"invalid_token","error_description":"Invalid Token"}' }),
    ['auth', 'Invalid Token'],
  );
  assert.deepEqual(kindOf({ status: 401, body: '' }), ['auth', 'API key refused (HTTP 401)']);
  assert.deepEqual(
    kindOf({
      status: 403,
      body: '{"error":"Missing Scopes","error_description":"Missing Scopes: homey.zone.readonly"}',
    }),
    ['forbidden', 'Missing Scopes: homey.zone.readonly'],
  );
  assert.deepEqual(kindOf({ status: 404, body: '{"error":"not_found"}' }), [
    'notfound',
    'not_found',
  ]);
  assert.deepEqual(kindOf({ status: 500, body: '{"error":"Device Unavailable"}' }), [
    'api',
    'Device Unavailable (HTTP 500)',
  ]);
  assert.deepEqual(kindOf({ status: 502, body: '<html>Bad gateway</html>' }), ['api', 'HTTP 502']);
  assert.deepEqual(
    kindOf({
      status: 302,
      headers: { location: 'https://192-168-1-20.homey.homeylocal.com/x' },
      body: '',
    }),
    ['redirect', 'redirected to https://192-168-1-20.homey.homeylocal.com'],
  );
  assert.deepEqual(kindOf({ status: 301, headers: { location: '/login' }, body: '' }), [
    'redirect',
    'redirected to /login',
  ]);
  assert.deepEqual(kindOf({ status: 200, body: '<html>router</html>' }), [
    'format',
    'not a Homey API answer',
  ]);
  assert.deepEqual(kindOf({ status: 101, body: '' }), ['http', 'HTTP 101']);
});

test('homeyOf: the X-Homey-ID header tells a Homey', () => {
  assert.deepEqual(
    homeyOf({ status: 200, headers: { 'x-homey-id': 'abc', 'x-homey-version': '12.4.1' } }),
    {
      id: 'abc',
      version: '12.4.1',
    },
  );
  assert.deepEqual(homeyOf({ status: 200, headers: { 'x-homey-id': 'abc' } }), {
    id: 'abc',
    version: undefined,
  });
  assert.throws(
    () => homeyOf({ status: 200, headers: {} }),
    (err) => err.kind === 'not-homey',
  );
  assert.throws(() => homeyOf({ status: 404 }), /HTTP 404, not a Homey Pro/);
});

test('networkError: the reasons, never the URL', () => {
  assert.deepEqual(
    [networkError({ code: 'ECONNREFUSED' }).kind, networkError({ code: 'ECONNREFUSED' }).message],
    ['network', 'connection refused'],
  );
  assert.equal(networkError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }).kind, 'certificate');
  assert.equal(networkError({ code: 'EWEIRD' }).message, 'EWEIRD');
  const same = new HomeyError('timeout', 'x');
  assert.equal(networkError(same), same);
});

test('the client: the requests it sends, the Bearer key', async () => {
  const requests = [];
  const request = async (url, options) => {
    requests.push({ url, ...options, agent: undefined });
    if (url.endsWith('/ping')) {
      return {
        status: 200,
        headers: { 'x-homey-id': HOMEY_ID, 'x-homey-version': HOMEY_VERSION },
        body: 'true',
      };
    }
    return { status: 200, headers: {}, body: '{}' };
  };
  const client = createClient({ url: 'http://192.168.1.20', apiKey: KEY, request });
  assert.deepEqual(await client.ping(), { id: HOMEY_ID, version: HOMEY_VERSION });
  assert.equal(requests[0].headers, undefined, 'the ping carries no key');
  await client.devices();
  await client.zones();
  await client.setCapability('6d1e4f2a-0000-4000-8000-000000000007', 'onoff.2', true);
  client.close();
  assert.deepEqual(
    requests.slice(1).map((r) => [r.method ?? 'GET', r.url.replace('http://192.168.1.20', '')]),
    [
      ['GET', '/api/manager/devices/device'],
      ['GET', '/api/manager/zones/zone'],
      [
        'PUT',
        '/api/manager/devices/device/6d1e4f2a-0000-4000-8000-000000000007/capability/onoff.2',
      ],
    ],
  );
  assert.equal(requests[1].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(requests[1].timeout, 60_000, 'the device list gets the long timeout');
  const body = JSON.parse(requests[3].body);
  assert.equal(body.value, true);
  assert.match(body.transactionId, /^gladys-\d+-1$/);
  assert.equal(requests[3].headers['Content-Type'], 'application/json');
});

test('the client against the simulated Homey', async (t) => {
  const sim = await homeyServer();
  t.after(() => sim.close());
  const client = createClient({ url: sim.url, apiKey: KEY });
  t.after(() => client.close());
  assert.deepEqual(await client.ping(), { id: HOMEY_ID, version: HOMEY_VERSION });
  const devices = await client.devices();
  assert.equal(Object.keys(devices).length, 24);
  assert.equal(Object.keys(await client.zones()).length, 6);
  const lamp = Object.values(devices).find((d) => d.name === 'Lampe salon');
  assert.deepEqual(await client.setCapability(lamp.id, 'dim', 0.3), {});
  assert.equal(sim.devices[lamp.id].capabilitiesObj.dim.value, 0.3);
  // One device read before a guarded command, over real HTTP.
  const one = await client.device(lamp.id, { timeout: 2000 });
  assert.equal(one.id, lamp.id);
  assert.equal(one.capabilitiesObj.dim.value, 0.3);
  assert.equal(sim.requests.at(-1).path, `/api/manager/devices/device/${lamp.id}`);
  assert.equal(sim.requests.at(-1).auth, `Bearer ${KEY}`);
  await assert.rejects(client.device('missing'), (err) => err.kind === 'notfound');
  await assert.rejects(client.setCapability(lamp.id, 'nope', 1), (err) => err.kind === 'notfound');
  sim.zonesForbidden = true;
  await assert.rejects(
    client.zones(),
    (err) => err.kind === 'forbidden' && /homey\.zone\.readonly/.test(err.message),
  );
  const wrong = createClient({ url: sim.url, apiKey: 'wrong' });
  await assert.rejects(
    wrong.devices(),
    (err) => err.kind === 'auth' && err.message === 'Invalid Token',
  );
  wrong.close();
});

test('httpRequest: timeout, size limit (settled once), refused connection', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') {
      return; // never answers
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ blob: 'x'.repeat(5000) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(
    httpRequest(`${base}/slow`, { timeout: 100 }),
    (err) => err.kind === 'timeout' && err.message === 'no answer within 1 s',
  );
  await assert.rejects(
    httpRequest(`${base}/big`, { timeout: 2000, maxBytes: 1000 }),
    (err) => err.kind === 'size',
  );
  const ok = await httpRequest(`${base}/big`, { timeout: 2000 });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).blob.length, 5000);

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(
    httpRequest(`http://127.0.0.1:${port}/`, { timeout: 2000 }),
    (err) => err.kind === 'network' && err.message === 'connection refused',
  );
});
