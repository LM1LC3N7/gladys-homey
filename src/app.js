// -----------------------------------------------------------------------------
// The integration: one Homey Pro, its devices turned into Gladys devices, the
// realtime events feeding the states, and the commands sent back. index.js
// only wires the SDK handlers to it.
//
// Lifecycle: start -> open (address typed, or found by mDNS; ping; devices
// and zones) -> the realtime socket (src/realtime.js) brings every capability
// change, and the whole device list is read again every 5 minutes (missed
// events, renames). Without the socket (refused, lost), the device list is
// read every 10 seconds and the socket is tried again in the background. On a
// failure of the HTTP API, reconnect with a growing delay; after a few, look
// for the same Homey (by its id) at another address.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import { REALTIME, TIMINGS } from './constants.js';
import { buildModel, emptyModel } from './devices.js';
import { homeyCandidates } from './discovery.js';
import { HomeyError, createClient } from './homey.js';
import { T } from './i18n.js';
import { asList, buildInventory, zoneNames } from './inventory.js';
import { StatePublisher } from './publisher.js';
import { RealtimeError, openRealtime } from './realtime.js';

/** Failures that keep the same answer until the user changes something. */
const SLOW_FAILURES = new Set(['auth', 'forbidden', 'not-homey']);
/** Failures after which Homey may have moved to another address. */
const MOVED_FAILURES = new Set(['network', 'timeout', 'not-homey']);
const DEVICE_URI = 'homey:device:';

/** The time of a capability change, as Homey dates it (ISO). */
function dateOf(raw, now) {
  const date = new Date(raw ?? now);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(now).toISOString();
}

const lastUpdatedOf = (device, capabilityId) =>
  device?.capabilitiesObj?.[capabilityId]?.lastUpdated ?? undefined;

export class HomeyApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'homey' }),
    connect = createClient,
    realtime = openRealtime,
    WebSocket = globalThis.WebSocket,
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.realtime = realtime;
    this.WebSocket = WebSocket;
    this.now = now;
    this.timers = timers;
    this.raw = {};
    this.config = normalizeConfig();
    this.client = null;
    /** { id, version } of the Homey answering */
    this.homey = undefined;
    this.model = emptyModel();
    /** Homey device id -> last device record (replaced, never mutated) */
    this.records = new Map();
    /** the last zones answer, and when it was read */
    this.zones = {};
    this.zoneIds = new Set();
    this.zonesReadAt = 0;
    this.online = false;
    /** the realtime session, and its state: off | connecting | live | down */
    this.live = null;
    this.liveState = 'off';
    this.liveError = undefined;
    this.liveFailures = 0;
    /** bumped when the socket opens or closes: a read spanning it reports no presses */
    this.liveEpoch = 0;
    this.readEpoch = 0;
    this.subscribed = new Set();
    /** the generation whose socket is being opened */
    this.liveOpening = undefined;
    /** started with a valid configuration */
    this.running = false;
    /** the last refusal of a subscription */
    this.subscribeError = undefined;
    /** feature id -> last value read, sent when the user creates the device */
    this.lastValues = new Map();
    this.created = new Set();
    /** device id -> last badge published (JSON) */
    this.transports = new Map();
    this.timer = undefined;
    this.modelTimer = undefined;
    this.liveTimer = undefined;
    this.reading = false;
    this.failures = 0;
    this.lastError = undefined;
    this.rediscoveredAt = -Infinity;
    this.scanning = undefined;
    this.generation = 0;
    this.lastStatus = undefined;
    this.publishedDevices = undefined;
    this.warned = new Set();
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    this.raw = { ...(raw ?? {}) };
    this.config = normalizeConfig(this.raw);
    this.refreshCreated();
    if (this.config.error) {
      await this.setStatus(false, T.configError(this.config.error));
      return;
    }
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: this.model.throttled,
    });
    this.running = true;
    this.publisher.start();
    await this.setStatus(false, T.connecting);
    await this.open(generation);
  }

  /** The configuration changed: reconnect, unless only what the integration saved itself did. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    const same = (c) => JSON.stringify([c.url ?? null, c.discover, c.apiKey, c.sensorInterval]);
    // Unchanged while connected or connecting: the echo of our own setConfig, kept as is.
    const healthy = this.running && (this.online || this.failures === 0);
    if (healthy && !next.error && same(next) === same(this.config)) {
      this.raw = { ...raw };
      this.config = next;
      return;
    }
    this.logger.info('Configuration updated: reconnecting to Homey');
    await this.start(raw);
  }

  stop() {
    this.generation += 1;
    this.running = false;
    this.timers.clearTimeout(this.timer);
    this.timers.clearTimeout(this.modelTimer);
    this.timers.clearTimeout(this.liveTimer);
    this.timer = undefined;
    this.modelTimer = undefined;
    this.liveTimer = undefined;
    this.publisher.stop();
    this.closeLive('off');
    this.client?.close?.();
    this.client = null;
    this.online = false;
    this.reading = false;
    this.failures = 0;
    this.liveFailures = 0;
  }

  current(generation) {
    return generation === this.generation;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async connectedStatus() {
    await this.setStatus(
      true,
      T.connected(this.homey?.version, this.model.devices.length, this.liveState, this.liveError),
    );
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  /** Runs `fn` after `ms` on the main timer, unless the app was restarted or stopped meanwhile. */
  schedule(generation, ms, fn) {
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      if (this.current(generation)) {
        fn().catch((err) => this.logger.error(`Homey loop: ${err.message}`));
      }
    }, ms);
  }

  // --- Finding Homey -----------------------------------------------------------

  /** One mDNS scan at a time; resolves the Homeys found, confirmed by their ping. */
  discover() {
    if (!this.scanning) {
      this.scanning = this.scan().finally(() => {
        this.scanning = undefined;
      });
    }
    return this.scanning;
  }

  async scan() {
    let results;
    try {
      results = await this.gladys.scanNetwork('mdns', { timeoutSeconds: TIMINGS.mdnsSeconds });
    } catch (err) {
      throw new HomeyError('discovery', err?.message ?? 'scan failed');
    }
    const found = [];
    for (const candidate of homeyCandidates(results)) {
      const client = this.connect({ url: candidate.url, apiKey: '' });
      try {
        const homey = await client.ping({ timeout: 5000 });
        if (!found.some((f) => f.id === homey.id)) {
          found.push({ url: candidate.url, ...homey });
        }
      } catch {
        // Another device announcing the service, or unreachable: not a Homey to use.
      } finally {
        client.close?.();
      }
    }
    return found;
  }

  /** Keeps a value the integration found (address, Homey id) in the configuration. */
  async remember(values) {
    this.raw = { ...this.raw, ...values };
    this.config = normalizeConfig(this.raw);
    await this.gladys
      .setConfig(values)
      .catch((err) => this.logger.warn(`Saving the configuration failed: ${err.message}`));
  }

  /** The Homey found, by its saved id, or the only one. */
  pick(found) {
    const known = this.config.homeyId && found.find((f) => f.id === this.config.homeyId);
    if (known) {
      return known;
    }
    if (found.length === 1) {
      return found[0];
    }
    if (found.length === 0) {
      throw new HomeyError('not-found', 'no Homey Pro answered');
    }
    throw new HomeyError('several', found.map((f) => f.url.replace(/^http:\/\//, '')).join(', '));
  }

  /** The address to use: the one typed, else found by mDNS (and again after it went silent). */
  async resolveAddress() {
    const typed = this.config.url;
    const moved =
      typed &&
      this.config.homeyId &&
      this.failures >= TIMINGS.rediscoverAfter &&
      MOVED_FAILURES.has(this.lastError?.kind) &&
      this.now() - this.rediscoveredAt >= TIMINGS.rediscoverEvery;
    if (typed && !moved) {
      return typed;
    }
    if (moved) {
      this.rediscoveredAt = this.now();
      const found = await this.discover().catch(() => []);
      const same = found.find((f) => f.id === this.config.homeyId);
      if (same && same.url !== typed) {
        this.logger.info(`Homey ${same.id} found at a new address, ${same.url}`);
        await this.remember({ homey_address: same.url });
        return same.url;
      }
      return typed;
    }
    const homey = this.pick(await this.discover());
    this.logger.info(`Homey ${homey.id} found on the network at ${homey.url}`);
    await this.remember({ homey_address: homey.url, homey_id: homey.id });
    return homey.url;
  }

  // --- Connection ----------------------------------------------------------------

  /** Connects: the address, the ping, the devices and zones, then the realtime socket. */
  async open(generation) {
    try {
      const url = await this.resolveAddress();
      if (!this.current(generation)) {
        return;
      }
      if (this.client?.url !== url) {
        this.client?.close?.();
        this.client = this.connect({ url, apiKey: this.config.apiKey });
      }
      const homey = await this.client.ping();
      if (!this.current(generation)) {
        return;
      }
      if (homey.id !== this.config.homeyId) {
        await this.remember({ homey_id: homey.id });
      }
      this.homey = homey;
      await this.loadAll(generation, { initial: true });
      if (!this.current(generation)) {
        return;
      }
      this.online = true;
      this.failures = 0;
      this.lastError = undefined;
      this.logger.info(
        `Connected to Homey ${homey.version ?? ''} (${homey.id}) at ${url}: ${this.model.devices.length} devices offered`,
      );
      this.liveState = 'connecting';
      await this.connectedStatus();
      await this.publishAllTransports();
      this.scheduleRead(generation);
      this.startLive(generation);
    } catch (err) {
      await this.fail(generation, err);
    }
  }

  async fail(generation, err) {
    if (!this.current(generation)) {
      return;
    }
    this.online = false;
    this.reading = false;
    this.closeLive('off');
    this.timers.clearTimeout(this.liveTimer);
    this.failures += 1;
    this.lastError = err;
    const delay = SLOW_FAILURES.has(err?.kind)
      ? TIMINGS.authRetry
      : Math.min(TIMINGS.retryMax, TIMINGS.retryMin * 2 ** (this.failures - 1));
    if (err instanceof HomeyError) {
      this.logger.warn(`Homey: ${err.message} (retrying in ${Math.round(delay / 1000)} s)`);
    } else {
      this.logger.error('Homey: unexpected failure', err);
    }
    await this.setStatus(false, T.failure(err));
    await this.publishAllTransports();
    this.schedule(generation, delay, () => this.open(generation));
  }

  // --- Reading the devices ---------------------------------------------------------

  readInterval() {
    return this.liveState === 'live' ? TIMINGS.resync : TIMINGS.fallbackPoll;
  }

  scheduleRead(generation, ms = this.readInterval()) {
    this.schedule(generation, ms, () => this.read(generation));
  }

  async read(generation) {
    this.reading = true;
    try {
      await this.loadAll(generation);
    } catch (err) {
      await this.fail(generation, err);
      return;
    } finally {
      if (this.current(generation)) {
        this.reading = false;
      }
    }
    if (this.current(generation) && this.online) {
      await this.connectedStatus();
      this.scheduleRead(generation);
    }
  }

  /** After a command without realtime events: read soon, not at the next tick. */
  readSoon() {
    const generation = this.generation;
    if (this.online && !this.reading && this.liveState !== 'live') {
      this.scheduleRead(generation, TIMINGS.commandEcho);
    }
  }

  async readZones(client = this.client, timeout = TIMINGS.requestTimeout) {
    try {
      this.zones = (await client.zones({ timeout })) ?? {};
    } catch (err) {
      if (err?.kind !== 'forbidden' && err?.kind !== 'notfound') {
        throw err;
      }
      this.warnOnce(
        'zones',
        `Reading the Homey zones refused (${err.message}): names without zones`,
      );
    }
    this.zoneIds = new Set(zoneNames(this.zones).keys());
    this.zonesReadAt = this.now();
  }

  zonesStale(devices) {
    return (
      this.now() - this.zonesReadAt >= TIMINGS.zonesRefresh ||
      devices.some((d) => d?.zone && !this.zoneIds.has(String(d.zone)))
    );
  }

  /**
   * Reads every device (and the zones when needed); publishes the devices and
   * the values. Presses are told by a new `lastUpdated` of a button, only
   * when no realtime session ran since the previous read (it sent them).
   */
  async loadAll(generation, { initial = false, force = false } = {}) {
    const live = this.liveState === 'live' || this.liveEpoch !== this.readEpoch;
    this.readEpoch = this.liveEpoch;
    const answer = await this.client.devices();
    if (!this.current(generation)) {
      return;
    }
    const devices = asList(answer);
    if (initial || this.zonesStale(devices)) {
      await this.readZones();
      if (!this.current(generation)) {
        return;
      }
    }
    const known = new Set(devices.map((d) => d?.id));
    for (const id of this.records.keys()) {
      if (!known.has(id)) {
        this.records.delete(id);
      }
    }
    await this.rebuild(devices, { force });
    for (const device of devices) {
      if (device && typeof device.id === 'string') {
        this.applyDevice(device, { initial, presses: !initial && !live });
      }
    }
  }

  /** The model from these device records; published when it changed; new devices subscribed. */
  async rebuild(devices, { force = false } = {}) {
    const inventory = buildInventory({ devices, zones: this.zones });
    const model = buildModel((id) => this.idsOf(id), inventory);
    this.inventory = inventory;
    this.model = model;
    this.publisher.configure({
      intervalSeconds: this.config.sensorInterval,
      throttled: model.throttled,
    });
    const json = JSON.stringify(model.devices);
    if (force || json !== this.publishedDevices) {
      try {
        await this.gladys.publishDiscoveredDevices(model.devices);
        this.publishedDevices = json;
        this.logger.info(
          `${model.devices.length} devices offered in Discovery (${inventory.devices.length} Homey devices)`,
        );
      } catch (err) {
        this.logger.error(`Publishing the discovered devices failed: ${err.message}`);
      }
    }
    await this.subscribeAll();
  }

  /**
   * One device record: its values to the features, its presses as events
   * (`presses`: a new lastUpdated of a button), its badge.
   */
  applyDevice(device, { initial = false, presses = false } = {}) {
    const previous = this.records.get(device.id);
    this.records.set(device.id, device);
    for (const reader of this.model.readers.get(device.id) ?? []) {
      if (reader.event) {
        const pressed =
          presses &&
          previous !== undefined &&
          reader.caps.some((cap) => {
            const date = lastUpdatedOf(device, cap);
            return date !== undefined && date !== lastUpdatedOf(previous, cap);
          });
        if (pressed) {
          this.press(reader, device);
        }
        continue;
      }
      this.readOne(reader, device);
    }
    if (!initial) {
      this.publishTransportOf(device.id);
    }
  }

  readOne(reader, device) {
    let value;
    try {
      value = reader.read(device);
    } catch (err) {
      this.warnOnce(`read:${reader.featureId}`, `${reader.featureId}: ${err.message}`);
      return;
    }
    if (value) {
      this.record(reader.featureId, value);
    }
  }

  press(reader, device) {
    if (this.created.has(reader.featureId)) {
      this.publisher.pushEvent(reader.featureId, reader.read(device));
    }
  }

  /** Keeps the value, and sends it when the device exists in Gladys. */
  record(featureId, value) {
    this.lastValues.set(featureId, value);
    if (this.created.has(featureId)) {
      this.publisher.push(featureId, value);
    }
  }

  // --- Realtime events -----------------------------------------------------------

  startLive(generation) {
    const ready = this.current(generation) && this.online && this.client && this.homey;
    if (!ready || this.live || this.liveOpening === generation) {
      return;
    }
    this.liveOpening = generation;
    this.subscribeError = undefined;
    this.liveState = this.liveState === 'down' ? 'down' : 'connecting';
    this.realtime({
      url: this.client.url,
      token: this.config.apiKey,
      homeyId: this.homey.id,
      WebSocket: this.WebSocket,
      timers: this.timers,
      onEvent: (uri, event, data) => {
        if (this.current(generation)) {
          this.onLiveEvent(generation, uri, event, data);
        }
      },
      onClose: (reason) => {
        if (this.current(generation)) {
          this.live = null;
          this.subscribed = new Set();
          this.liveFailed(generation, new RealtimeError('closed', reason)).catch(() => {});
        }
      },
    })
      .finally(() => {
        if (this.liveOpening === generation) {
          this.liveOpening = undefined;
        }
      })
      .then(async (session) => {
        if (!this.current(generation) || !this.online) {
          session.close();
          return;
        }
        this.live = session;
        this.subscribed = new Set();
        const ok = await this.subscribeAll();
        if (!ok || !this.current(generation) || this.live !== session) {
          if (this.live === session) {
            session.close();
            this.live = null;
            throw this.subscribeError ?? new RealtimeError('refused', 'subscriptions refused');
          }
          return;
        }
        this.liveState = 'live';
        this.liveEpoch += 1;
        this.liveFailures = 0;
        this.liveError = undefined;
        this.logger.info(`Live updates on (${this.subscribed.size} subscriptions)`);
        await this.connectedStatus();
        await this.publishAllTransports();
        // The changes between the last read and the subscriptions: read once now.
        if (!this.reading) {
          this.scheduleRead(generation, 0);
        }
      })
      .catch((err) => this.liveFailed(generation, err));
  }

  async liveFailed(generation, err) {
    if (!this.current(generation) || !this.online) {
      return;
    }
    const wasDown = this.liveState === 'down';
    if (this.liveState === 'live') {
      this.liveEpoch += 1;
    }
    this.liveState = 'down';
    this.liveError = err;
    this.liveFailures += 1;
    const slow = err?.kind === 'auth' || err?.kind === 'forbidden';
    const delay = slow
      ? TIMINGS.authRetry
      : Math.min(TIMINGS.realtimeRetryMax, TIMINGS.realtimeRetryMin * 2 ** (this.liveFailures - 1));
    this.logger.warn(
      `Homey live updates: ${err?.message ?? err} (reading every ${TIMINGS.fallbackPoll / 1000} s, socket again in ${Math.round(delay / 1000)} s)`,
    );
    this.timers.clearTimeout(this.liveTimer);
    this.liveTimer = this.timers.setTimeout(() => {
      this.liveTimer = undefined;
      this.startLive(generation);
    }, delay);
    // Reading every 10 s from now on (already so when the socket was down).
    if (!wasDown && !this.reading) {
      this.scheduleRead(generation, TIMINGS.fallbackPoll);
    }
    await this.connectedStatus();
    await this.publishAllTransports();
  }

  closeLive(state) {
    const session = this.live;
    this.live = null;
    this.subscribed = new Set();
    session?.close();
    if (this.liveState === 'live') {
      this.liveEpoch += 1;
    }
    this.liveState = state;
  }

  /**
   * Subscribes the device manager and every offered device not subscribed
   * yet. Resolves false when every subscription was refused.
   */
  async subscribeAll() {
    const session = this.live;
    if (!session) {
      return false;
    }
    const uris = [REALTIME.devices, ...[...this.model.deviceIds.values()].map(REALTIME.device)];
    const missing = uris.filter((uri) => !this.subscribed.has(uri));
    for (const uri of missing) {
      this.subscribed.add(uri);
    }
    const results = await Promise.allSettled(missing.map((uri) => session.subscribe(uri)));
    let refused = 0;
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        refused += 1;
        this.subscribed.delete(missing[i]);
        this.subscribeError = result.reason;
        this.warnOnce(
          `subscribe:${missing[i]}`,
          `Subscribing to ${missing[i]} failed: ${result.reason?.message}`,
        );
      }
    });
    return missing.length === 0 || refused < missing.length;
  }

  onLiveEvent(generation, uri, event, data) {
    if (uri === REALTIME.devices) {
      const id = data?.id;
      if (typeof id !== 'string') {
        return;
      }
      if (event === 'device.create' || event === 'device.update') {
        const previous = this.records.get(id);
        // A device update carries its properties: kept with the values known so far.
        this.applyDevice(previous ? { ...previous, ...data } : data, { presses: false });
        this.scheduleModel(generation);
      } else if (event === 'device.delete') {
        this.records.delete(id);
        this.scheduleModel(generation);
      }
      return;
    }
    if (uri.startsWith(DEVICE_URI) && event === 'capability') {
      this.applyCapability(uri.slice(DEVICE_URI.length), data);
    }
  }

  /** One capability change: the record, the features reading it, a press. */
  applyCapability(deviceId, change) {
    const device = this.records.get(deviceId);
    const capabilityId = change?.capabilityId;
    if (!device || typeof capabilityId !== 'string') {
      return;
    }
    const caps = device.capabilitiesObj ?? {};
    const updated = {
      ...device,
      capabilitiesObj: {
        ...caps,
        [capabilityId]: {
          ...(caps[capabilityId] ?? { id: capabilityId }),
          value: change.value,
          lastUpdated: dateOf(change.transactionTime, this.now()),
        },
      },
    };
    this.records.set(deviceId, updated);
    for (const reader of this.model.readers.get(deviceId) ?? []) {
      if (!reader.caps.includes(capabilityId)) {
        continue;
      }
      if (reader.event) {
        if (change.value !== false) {
          this.press(reader, updated);
        }
      } else {
        this.readOne(reader, updated);
      }
    }
  }

  /** Devices created, renamed, moved or deleted in Homey: the model again, after the burst. */
  scheduleModel(generation) {
    this.timers.clearTimeout(this.modelTimer);
    this.modelTimer = this.timers.setTimeout(() => {
      this.modelTimer = undefined;
      if (!this.current(generation) || !this.online) {
        return;
      }
      this.refreshModel(generation).catch((err) =>
        this.logger.warn(`Updating the Homey devices failed: ${err.message}`),
      );
    }, TIMINGS.modelDebounce);
  }

  async refreshModel(generation) {
    const devices = [...this.records.values()];
    if (this.zonesStale(devices)) {
      await this.readZones();
    }
    if (!this.current(generation)) {
      return;
    }
    await this.rebuild(devices);
    for (const device of devices) {
      this.applyDevice(device, { initial: true });
    }
    await this.connectedStatus();
    await this.publishAllTransports();
  }

  // --- Inventory -----------------------------------------------------------------

  idsOf(id) {
    return this.gladys.externalIds('homey', id);
  }

  deviceIdOf(id) {
    const ids = this.idsOf(id);
    return this.model.deviceIds.has(ids.device) ? ids.device : undefined;
  }

  /** The Scan button of the Discovery tab. */
  async rescan() {
    if (!this.online || !this.client) {
      await this.gladys.publishDiscoveredDevices(this.model.devices);
      return;
    }
    await this.loadAll(this.generation, { force: true });
  }

  // --- Transport badges ----------------------------------------------------------

  /** The badge of a device: Homey reachable, the device available, the live updates on. */
  transportOf(deviceId) {
    if (!this.online) {
      return { transport: DEVICE_TRANSPORTS.UNREACHABLE };
    }
    const device = this.records.get(this.model.deviceIds.get(deviceId));
    if (device?.available === false) {
      // The SDK shows a message only with `degraded`: unreachable, and why.
      return {
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
        degraded: true,
        message: T.badge.unavailable(device.unavailableMessage),
      };
    }
    if (this.liveState === 'down') {
      return { transport: DEVICE_TRANSPORTS.LOCAL, degraded: true, message: T.badge.noLive };
    }
    return { transport: DEVICE_TRANSPORTS.LOCAL };
  }

  publishTransportOf(id) {
    const deviceId = this.deviceIdOf(id);
    if (deviceId) {
      this.publishTransport(deviceId).catch((err) =>
        this.logger.warn(`Transport badge failed: ${err.message}`),
      );
    }
  }

  async publishTransport(deviceId) {
    if (!this.createdDevices().has(deviceId)) {
      return;
    }
    const badge = this.transportOf(deviceId);
    const key = JSON.stringify(badge);
    if (this.transports.get(deviceId) === key) {
      return;
    }
    this.transports.set(deviceId, key);
    await this.gladys.publishTransports([{ external_id: deviceId, ...badge }]);
  }

  async publishAllTransports() {
    const entries = [];
    for (const deviceId of this.createdDevices()) {
      const badge = this.transportOf(deviceId);
      const key = JSON.stringify(badge);
      if (this.transports.get(deviceId) !== key) {
        this.transports.set(deviceId, key);
        entries.push({ external_id: deviceId, ...badge });
      }
    }
    for (let i = 0; i < entries.length; i += 100) {
      await this.gladys
        .publishTransports(entries.slice(i, i + 100))
        .catch((err) => this.logger.warn(`Transport badges failed: ${err.message}`));
    }
  }

  // --- Devices created by the user -------------------------------------------------

  createdDevices() {
    return new Set((this.gladys.devices ?? []).map((d) => d.external_id));
  }

  refreshCreated() {
    this.created = new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async deviceCreated(device) {
    this.refreshCreated();
    this.transports.delete(device?.external_id);
    for (const f of device?.features ?? []) {
      const value = this.lastValues.get(f.external_id);
      if (value) {
        this.publisher.push(f.external_id, value);
      }
    }
    if (device?.external_id) {
      await this.publishTransport(device.external_id).catch(() => {});
    }
  }

  async deviceDeleted(device) {
    this.refreshCreated();
    if (device?.external_id) {
      this.transports.delete(device.external_id);
      this.publisher.forget(device.external_id);
    }
  }

  // --- Commands ------------------------------------------------------------------

  async setValue(device, feature, value) {
    const client = this.client;
    if (!client || !this.online) {
      throw new Error('Homey is not connected');
    }
    const writer = this.model.writers.get(feature.external_id);
    const id = this.model.owners.get(feature.external_id);
    if (!writer || id === undefined) {
      throw new Error(`${feature.name ?? feature.external_id} cannot be controlled`);
    }
    const calls = writer.write(value, this.records.get(id));
    for (const call of calls) {
      await client.setCapability(id, call.capabilityId, call.value);
    }
    this.logger.debug(`${calls.length} Homey capability set(s) for ${feature.external_id}`);
    this.readSoon();
  }

  // --- Configuration screen button ---------------------------------------------------

  /** Reads Homey, its devices and zones with the saved configuration, tries the socket, counts. */
  async testConnection() {
    const config = this.config;
    if (config.error) {
      return T.configError(config.error);
    }
    let url = config.url;
    let client;
    try {
      if (!url) {
        url = this.pick(await this.discover()).url;
      }
      client = this.connect({ url, apiKey: config.apiKey });
      const homey = await client.ping({ timeout: TIMINGS.testTimeout });
      const devices = await client.devices({ timeout: TIMINGS.testTimeout });
      let zones = {};
      let zonesReadable = true;
      try {
        zones = await client.zones({ timeout: TIMINGS.testTimeout });
      } catch (err) {
        if (err?.kind !== 'forbidden') {
          throw err;
        }
        zonesReadable = false;
      }
      const inventory = buildInventory({ devices, zones });
      const model = buildModel((id) => this.idsOf(id), inventory);
      let live = { ok: true };
      try {
        const session = await this.realtime({
          url,
          token: config.apiKey,
          homeyId: homey.id,
          WebSocket: this.WebSocket,
          timers: this.timers,
          timeout: TIMINGS.testTimeout,
        });
        try {
          await session.subscribe(REALTIME.devices);
        } finally {
          session.close();
        }
      } catch (err) {
        live = { ok: false, error: err };
      }
      return T.test.ok({
        version: homey.version,
        url,
        devices: model.devices.length,
        total: inventory.devices.length,
        empty: model.counts.empty,
        zones: zonesReadable ? inventory.zones : undefined,
        live,
      });
    } catch (err) {
      if (!(err instanceof HomeyError)) {
        this.logger.error('Connection test failed', err);
      }
      return T.failure(err);
    } finally {
      client?.close?.();
    }
  }
}
