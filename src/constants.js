// -----------------------------------------------------------------------------
// Keys shared with the manifest (frozen: users store them in their
// configuration) and the tuning of the integration.
// -----------------------------------------------------------------------------

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** Sensor throttling bounds (seconds), mirrored by the manifest. */
export const SENSOR_INTERVAL = { min: 0, max: 300, default: 10 };

/** The mDNS service a Homey Pro announces (manifest `network_discovery`). */
export const MDNS_SERVICE = '_homey._tcp';

/** The local Web API of Homey (the paths of the athombv/node-homey-api specification). */
export const API = {
  /** Answers anyone, with the X-Homey-ID and X-Homey-Version headers. */
  ping: '/api/manager/system/ping',
  devices: '/api/manager/devices/device',
  zones: '/api/manager/zones/zone',
  capability: (deviceId, capabilityId) =>
    `/api/manager/devices/device/${encodeURIComponent(deviceId)}/capability/${encodeURIComponent(capabilityId)}`,
};

/** The realtime events: Socket.IO 2 (Engine.IO 3) over a WebSocket, like node-homey-api. */
export const REALTIME = {
  path: '/socket.io/?EIO=3&transport=websocket',
  /** device.create / device.update / device.delete */
  devices: 'homey:manager:devices',
  /** capability: { capabilityId, value, transactionId, transactionTime } */
  device: (id) => `homey:device:${id}`,
};

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin for the other paths. */
  statesPerMinute: 250,
  /** Size of a Homey answer read (bytes): the device list of a big install is a few MB. */
  responseBytes: 32 * 1024 * 1024,
  /** Devices published at once (publishDiscoveredDevices). */
  devices: 2000,
  /** Characters of a transport badge message (SDK limit). */
  badgeMessage: 200,
};

export const TIMINGS = {
  /** The pending states are sent at this pace. */
  flushInterval: 1000,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * 60_000,
  /** One request (the device list gets `inventoryTimeout`). */
  requestTimeout: 15_000,
  inventoryTimeout: 60_000,
  /** One request of the connection test (the button waits 90 s). */
  testTimeout: 20_000,
  /** Connection, sign-in and namespace of the realtime socket. */
  realtimeTimeout: 15_000,
  /** With the realtime events, the whole device list is read again this often. */
  resync: 5 * 60_000,
  /** Without them, the device list is read at this pace. */
  fallbackPoll: 10_000,
  /** The realtime socket is opened again after a loss: this delay, doubled up to the max. */
  realtimeRetryMin: 5000,
  realtimeRetryMax: 2 * 60_000,
  /** The zones are read again this often (renamed rooms). */
  zonesRefresh: 10 * 60_000,
  /** A device created, renamed or moved in Homey: wait for the burst to end. */
  modelDebounce: 2000,
  /** After a Gladys command without realtime events, the devices are read this soon. */
  commandEcho: 500,
  /** Reconnection delays after a failure (doubled each time, up to the max). */
  retryMin: 5000,
  retryMax: 60_000,
  /** A refused API key is retried slowly: the user has to change it. */
  authRetry: 5 * 60_000,
  /** Duration of the mDNS scan. */
  mdnsSeconds: 5,
  /** Homey unreachable this many times in a row: look for it at another address. */
  rediscoverAfter: 3,
  /** At most one such search in this time. */
  rediscoverEvery: 10 * 60_000,
};
