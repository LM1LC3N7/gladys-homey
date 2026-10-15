import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, parseHomeyAddress } from '../src/config.js';

test('the address of Homey: an IP, a URL, a page of it', () => {
  assert.deepEqual(parseHomeyAddress('192.168.1.20'), { url: 'http://192.168.1.20' });
  assert.deepEqual(parseHomeyAddress(' http://192.168.1.20/ '), { url: 'http://192.168.1.20' });
  assert.deepEqual(parseHomeyAddress('http://192.168.1.20:8080/manager/devices'), {
    url: 'http://192.168.1.20:8080',
  });
  assert.deepEqual(parseHomeyAddress('https://192-168-1-20.homey.homeylocal.com'), {
    url: 'https://192-168-1-20.homey.homeylocal.com',
  });
  assert.deepEqual(parseHomeyAddress(''), { empty: true });
  assert.deepEqual(parseHomeyAddress(undefined), { empty: true });
});

test('the addresses that cannot be the local API', () => {
  assert.deepEqual(parseHomeyAddress('ftp://192.168.1.20'), { error: 'invalid' });
  assert.deepEqual(parseHomeyAddress('http://'), { error: 'invalid' });
  assert.deepEqual(parseHomeyAddress('http://me:secret@192.168.1.20'), { error: 'credentials' });
  assert.deepEqual(parseHomeyAddress('https://my.homey.app/homeys/abc'), { error: 'cloud' });
  assert.deepEqual(parseHomeyAddress('homey-5f7c.local'), { error: 'local-name' });
});

test('normalizeConfig: the key, discovery, the saved id, the bounds', () => {
  assert.deepEqual(normalizeConfig(), {
    url: undefined,
    discover: true,
    error: 'no-key',
    apiKey: '',
    homeyId: undefined,
    sensorInterval: DEFAULTS.sensor_interval,
  });
  const config = normalizeConfig({
    homey_address: '192.168.1.20',
    api_key: '  key  ',
    homey_id: 'abc',
    sensor_interval: 1000,
  });
  assert.equal(config.url, 'http://192.168.1.20');
  assert.equal(config.discover, false);
  assert.equal(config.error, undefined);
  assert.equal(config.apiKey, 'key');
  assert.equal(config.homeyId, 'abc');
  assert.equal(config.sensorInterval, 300);
  assert.equal(normalizeConfig({ api_key: 'k', sensor_interval: null }).sensorInterval, 10);
  assert.equal(normalizeConfig({ api_key: 'k', homey_address: 'my.homey.app' }).error, 'cloud');
});
