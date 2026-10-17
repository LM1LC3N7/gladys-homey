// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// `homey_id` is not in the config_schema: the integration saves there the id
// of the Homey it connected to, to find it again when its address changes.
// -----------------------------------------------------------------------------

import { SENSOR_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  homey_address: '',
  api_key: '',
  sensor_interval: SENSOR_INTERVAL.default,
  // Louis's rule: unlocking, garage doors, valves and alarms stay refused unless allowed.
  allow_unlock: false,
  allow_garage_door_control: false,
  allow_valve_control: false,
  allow_alarm_control: false,
};

/** A boolean of the configuration (Gladys may store it as a string). */
const bool = (raw, fallback) => {
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (raw === 'true' || raw === 1 || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === 0 || raw === '0') {
    return false;
  }
  return fallback;
};

/**
 * The base address of Homey from what the user typed: "192.168.1.20",
 * "http://192.168.1.20/", "https://192-168-1-20.homey.homeylocal.com".
 * @returns {{ url: string } | { empty: true } | { error: 'invalid' | 'credentials' | 'cloud' | 'local-name' }}
 */
export function parseHomeyAddress(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    return { empty: true };
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { error: 'invalid' };
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return { error: 'invalid' };
  }
  if (url.username || url.password) {
    return { error: 'credentials' };
  }
  if (/(^|\.)(homey\.app|athom\.com)$/i.test(url.hostname)) {
    // The web app (my.homey.app) is not the local API of the Homey.
    return { error: 'cloud' };
  }
  if (/\.local$/i.test(url.hostname)) {
    // mDNS names do not resolve in the container (bridge network).
    return { error: 'local-name' };
  }
  // The API lives at the root: a pasted page of the web interface keeps its origin only.
  return { url: url.origin };
}

const bounded = (raw, { min, max, default: fallback }) => {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/**
 * @returns {{ url?: string, discover: boolean, error?: string, apiKey: string, homeyId?: string, sensorInterval: number,
 *   allow: { lock: boolean, garage: boolean, valve: boolean, alarm: boolean } }}
 *   `discover`: no address typed, Homey is looked for on the network (mDNS)
 */
export function normalizeConfig(raw = {}) {
  const given = Object.fromEntries(
    Object.entries(raw ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== ''),
  );
  const c = { ...DEFAULTS, ...given };
  const target = parseHomeyAddress(c.homey_address);
  const apiKey = String(c.api_key ?? '').trim();
  let error = target.error;
  if (!error && apiKey === '') {
    error = 'no-key';
  }
  return {
    url: target.url,
    discover: target.empty === true,
    error,
    apiKey,
    homeyId: String(c.homey_id ?? '').trim() || undefined,
    sensorInterval: Math.round(bounded(c.sensor_interval, SENSOR_INTERVAL)),
    allow: {
      lock: bool(c.allow_unlock, false),
      garage: bool(c.allow_garage_door_control, false),
      valve: bool(c.allow_valve_control, false),
      alarm: bool(c.allow_alarm_control, false),
    },
  };
}
