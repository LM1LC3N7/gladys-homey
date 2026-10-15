// A fake Homey behind the client of src/homey.js and the realtime session of
// src/realtime.js: the devices and zones of the fixtures, the capability sets
// with their effect and their realtime echo, the events of the device
// manager, failures and refusals.

import { HomeyError } from '../../src/homey.js';
import { RealtimeError } from '../../src/realtime.js';
import { HOMEY_ID, HOMEY_VERSION, answers, deviceNamed } from '../fixtures/homey.js';

export const URL_OF_HOMEY = 'http://192.168.1.20';
export const KEY = 'a1b2c3d4-0000-4000-8000-000000000000:e5f6:0123456789abcdef';

export function fakeHomey({ key = KEY } = {}) {
  const start = answers();
  const box = {
    ...start,
    id: HOMEY_ID,
    version: HOMEY_VERSION,
    /** the clock of Homey (ms) */
    clock: Date.parse('2026-10-15T08:00:00.000Z'),
    /** every HTTP call: { name, args } */
    calls: [],
    /** the capability sets: { deviceId, capabilityId, value } */
    executed: [],
    /** an error every HTTP call throws (ping included) */
    fail: undefined,
    /** call name -> error that call throws */
    failOn: {},
    /** the error the realtime session refuses with */
    liveRefusal: undefined,
    /** uri -> error its subscription is refused with */
    subscribeRefusals: {},
    /** realtime sessions: { options, subscribed: Set, closed } */
    sessions: [],
    clients: [],
    /** the base URLs Homey answers at */
    addresses: [URL_OF_HOMEY],
    /** base URL -> id of another Homey answering the ping there */
    others: new Map(),
  };

  box.device = (name) => deviceNamed(box.devices, name);
  box.callsOf = (name) => box.calls.filter((c) => c.name === name);
  box.live = () => box.sessions.find((s) => !s.closed);

  /** A capability changes in Homey: the device, then the realtime event. */
  box.emit = (name, capabilityId, value, { transactionId } = {}) => {
    box.clock += 1000;
    const device = box.device(name);
    const cap = device.capabilitiesObj[capabilityId];
    cap.value = value;
    cap.lastUpdated = new Date(box.clock).toISOString();
    const uri = `homey:device:${device.id}`;
    for (const session of box.sessions.filter((s) => !s.closed && s.subscribed.has(uri))) {
      session.options.onEvent?.(uri, 'capability', {
        capabilityId,
        value,
        transactionId: transactionId ?? `homey-${box.clock}`,
        transactionTime: box.clock,
      });
    }
    return device;
  };

  /** An event of the device manager (device.create, device.update, device.delete). */
  box.emitManager = (event, data) => {
    for (const session of box.sessions.filter(
      (s) => !s.closed && s.subscribed.has('homey:manager:devices'),
    )) {
      session.options.onEvent?.('homey:manager:devices', event, structuredClone(data));
    }
  };

  /** Homey drops the realtime socket. */
  box.dropLive = (reason = 'transport close') => {
    for (const session of box.sessions.filter((s) => !s.closed)) {
      session.closed = true;
      session.options.onClose?.(reason);
    }
  };

  function call(url, name, args, run) {
    box.calls.push({ name, args });
    if (name === 'ping' && box.others.has(url)) {
      return { id: box.others.get(url), version: box.version };
    }
    if (!box.addresses.includes(url)) {
      throw new HomeyError('network', 'connection refused');
    }
    if (box.fail) {
      throw box.fail;
    }
    if (box.failOn[name]) {
      throw box.failOn[name];
    }
    return run();
  }

  box.connect = (config) => {
    const signed = () => {
      if (config.apiKey !== key) {
        throw new HomeyError('auth', 'Invalid token', { status: 401 });
      }
    };
    const client = {
      url: config.url,
      config,
      closed: false,
      async ping() {
        return call(config.url, 'ping', { url: config.url }, () => ({
          id: box.id,
          version: box.version,
        }));
      },
      async devices() {
        return call(config.url, 'devices', {}, () => {
          signed();
          return structuredClone(box.devices);
        });
      },
      async zones() {
        return call(config.url, 'zones', {}, () => {
          signed();
          return structuredClone(box.zones);
        });
      },
      async setCapability(deviceId, capabilityId, value) {
        return call(config.url, 'setCapability', { deviceId, capabilityId, value }, () => {
          signed();
          const device = box.devices[deviceId];
          if (!device?.capabilitiesObj?.[capabilityId]) {
            throw new HomeyError('notfound', 'Capability not found', { status: 404 });
          }
          box.executed.push({ deviceId, capabilityId, value });
          if (capabilityId === 'button') {
            box.emit(device.name, capabilityId, true);
            device.capabilitiesObj.button.value = null;
          } else {
            box.emit(device.name, capabilityId, value);
          }
          return undefined;
        });
      },
      close() {
        client.closed = true;
      },
    };
    box.clients.push(client);
    return client;
  };

  /** Stands for openRealtime(). */
  box.realtime = async (options) => {
    box.calls.push({ name: 'realtime', args: { url: options.url, homeyId: options.homeyId } });
    if (!box.addresses.includes(options.url)) {
      throw new RealtimeError('network', 'connection refused');
    }
    if (box.fail) {
      throw new RealtimeError('network', box.fail.message);
    }
    if (options.token !== key) {
      throw new RealtimeError('auth', 'Invalid token');
    }
    if (box.liveRefusal) {
      throw box.liveRefusal;
    }
    const session = { options, subscribed: new Set(), closed: false };
    session.subscribe = async (uri) => {
      if (session.closed) {
        throw new RealtimeError('closed', 'closed');
      }
      if (box.subscribeRefusals[uri]) {
        throw box.subscribeRefusals[uri];
      }
      session.subscribed.add(uri);
    };
    session.close = () => {
      session.closed = true;
    };
    box.sessions.push(session);
    return session;
  };

  return box;
}

/** Lets the pending promises settle (no timer involved). */
export const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};
