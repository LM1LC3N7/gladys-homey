// -----------------------------------------------------------------------------
// The raw results of the mediated mDNS scan (gladys.scanNetwork('mdns'),
// service `_homey._tcp`, the only one the manifest declares) -> the addresses
// to try (pure). The scan returns `{ name, host, addresses, port, txt }` per
// instance. The local API answers on port 80 (`http://<IP>`, the `localUrl`
// of the Homey Web API): the advertised port is not used, and each address
// is confirmed by the X-Homey-ID header of the ping (src/homey.js).
// -----------------------------------------------------------------------------

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const LINK_LOCAL_V6 = /^fe[89ab][0-9a-f]:/i;

/** The address to reach a Homey with: IPv4 first, then a routable IPv6. */
export function bestAddress(addresses) {
  const list = (Array.isArray(addresses) ? addresses : []).filter((a) => typeof a === 'string');
  return (
    list.find((a) => IPV4.test(a)) ??
    list.find((a) => a.includes(':') && a !== '::1' && !LINK_LOCAL_V6.test(a))
  );
}

/**
 * @param {object[]} results raw mDNS scan results
 * @returns {Array<{ url: string, name: string }>} one base URL per address, in scan order
 */
export function homeyCandidates(results) {
  const seen = new Set();
  const list = [];
  for (const result of Array.isArray(results) ? results : []) {
    const address = bestAddress(result?.addresses);
    if (!address || seen.has(address)) {
      continue;
    }
    seen.add(address);
    list.push({
      url: address.includes(':') ? `http://[${address}]` : `http://${address}`,
      name: String(result?.name ?? '').split('.')[0],
    });
  }
  return list;
}
