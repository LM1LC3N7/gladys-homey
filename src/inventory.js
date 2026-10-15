// -----------------------------------------------------------------------------
// The Homey inventory: the devices and zones answers -> the devices to offer,
// each with the name of its zone (pure).
//
// Homey answers both lists as objects keyed by id. A device is in exactly one
// zone (`zone`: its id); the zones nest (`parent`), the zone of the device
// names it. Without the zones permission of the API key, the names stay bare.
// -----------------------------------------------------------------------------

/** Homey answers its lists as objects keyed by id: always a list. */
export const asList = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  return value && typeof value === 'object' ? Object.values(value) : [];
};

/** The zones answer -> Map(zone id -> name). */
export function zoneNames(zones) {
  const names = new Map();
  for (const zone of asList(zones)) {
    const name = String(zone?.name ?? '').trim();
    if (zone?.id && name !== '') {
      names.set(String(zone.id), name);
    }
  }
  return names;
}

/**
 * @param {{ devices: object, zones?: object }} answers the answers of
 *   GET /api/manager/devices/device and GET /api/manager/zones/zone
 * @returns {{ devices: Array<{ id: string, name: string, zone?: string, record: object }>, zones: number }}
 */
export function buildInventory({ devices, zones }) {
  const names = zoneNames(zones);
  const list = [];
  for (const record of asList(devices)) {
    if (!record || typeof record.id !== 'string' || record.id === '') {
      continue;
    }
    const zone = names.get(String(record.zone)) ?? String(record.zoneName ?? '').trim();
    list.push({
      id: record.id,
      name: String(record.name ?? '').trim() || `Homey ${record.id.slice(0, 8)}`,
      zone: zone || undefined,
      record,
    });
  }
  list.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { devices: list, zones: names.size };
}
