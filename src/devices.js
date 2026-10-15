// -----------------------------------------------------------------------------
// The Homey inventory -> Gladys devices and routing tables (pure).
//
// One Gladys device per Homey device. External ids:
//   device  ext:<selector>:homey:<device id>
//   feature <device>:<capability id>            (src/mapping.js)
// The id of a Homey device is a UUID that never changes while the device is
// paired: the external ids stay stable.
// -----------------------------------------------------------------------------

import { LIMITS } from './constants.js';
import { mapDevice } from './mapping.js';

/** Device names repeat from room to room ("Ceiling light"): the zone is part of the name. */
export const deviceName = (dev) =>
  (dev.zone ? `${dev.name} (${dev.zone})` : dev.name).slice(0, 100);

const paramsOf = (dev) =>
  [
    { name: 'HOMEY_DEVICE_ID', value: dev.id },
    { name: 'HOMEY_ZONE', value: dev.zone },
    { name: 'HOMEY_CLASS', value: dev.record.virtualClass ?? dev.record.class },
    { name: 'HOMEY_DRIVER', value: dev.record.driverId ?? dev.record.driverUri },
  ]
    .filter((p) => p.value !== undefined && p.value !== null && String(p.value) !== '')
    .map((p) => ({ name: p.name, value: String(p.value).slice(0, 255) }));

export function emptyModel() {
  return {
    devices: [],
    /** Homey device id -> [{ featureId, caps, read, event }] */
    readers: new Map(),
    /** feature id -> { write } */
    writers: new Map(),
    /** feature id -> Homey device id (the API calls name the device) */
    owners: new Map(),
    throttled: new Set(),
    /** Gladys device id -> Homey device id */
    deviceIds: new Map(),
    /** devices read, left out because nothing maps or over the limit; capabilities left out */
    counts: { devices: 0, empty: 0, overflow: 0, skipped: 0 },
  };
}

/**
 * @param {(id: string) => { device: string, feature: (key: string) => string }} idsOf
 *   the external ids of one device (gladys.externalIds('homey', id))
 * @param {{ devices: object[] }} inventory see src/inventory.js
 */
export function buildModel(idsOf, inventory) {
  const model = emptyModel();
  for (const dev of inventory.devices) {
    model.counts.devices += 1;
    const mapped = mapDevice(dev.record);
    model.counts.skipped += mapped.skipped.length;
    if (mapped.features.length === 0) {
      model.counts.empty += 1;
      continue;
    }
    if (model.devices.length >= LIMITS.devices) {
      model.counts.overflow += 1;
      continue;
    }
    const ids = idsOf(dev.id);
    model.devices.push({
      name: deviceName(dev),
      external_id: ids.device,
      should_poll: false,
      params: paramsOf(dev),
      features: mapped.features.map(({ key, ...feature }) => ({
        ...feature,
        external_id: ids.feature(key),
      })),
    });
    model.deviceIds.set(ids.device, dev.id);
    model.readers.set(
      dev.id,
      mapped.readers.map(({ key, caps, read, event }) => ({
        featureId: ids.feature(key),
        caps,
        read,
        event,
      })),
    );
    for (const [key, writer] of Object.entries(mapped.writers)) {
      model.writers.set(ids.feature(key), writer);
      model.owners.set(ids.feature(key), dev.id);
    }
    for (const key of mapped.throttled) {
      model.throttled.add(ids.feature(key));
    }
  }
  return model;
}
