// The answers of a Homey Pro (2023), shaped like the local Web API answers
// (the device and zone schemas of the athombv/node-homey-api specification):
// 24 devices in 6 zones, one of each kind the integration maps, plus a
// speaker it leaves out. Fresh copies: tests may change them.

import { readFileSync } from 'node:fs';

const read = (name) =>
  JSON.parse(readFileSync(new URL(`./homey-pro-2023/${name}.json`, import.meta.url), 'utf8'));

export const HOMEY_ID = '5f7c2a91d3e4b60012ab34cd';
export const HOMEY_VERSION = '12.4.1';

export const answers = () => ({ devices: read('devices'), zones: read('zones') });

/** The device of the fixtures named so. */
export function deviceNamed(devices, name) {
  const device = Object.values(devices).find((d) => d.name === name);
  if (!device) {
    throw new Error(`no device ${name} in the fixtures`);
  }
  return device;
}
