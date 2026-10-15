// -----------------------------------------------------------------------------
// The local Web API of a Homey Pro over HTTP: the only network access besides
// the realtime socket (src/realtime.js).
//
// Every request carries the API key as "Authorization: Bearer <key>" (an API
// key created in the Homey web app, Settings → API Keys). The answers are
// JSON; an error is a 4xx/5xx status with `{ error, error_description }`.
// `GET /api/manager/system/ping` answers anyone, and its X-Homey-ID header
// tells that a Homey answered (and which one). The paths follow the
// specification shipped with athombv/node-homey-api, read as documentation.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { API, LIMITS, TIMINGS } from './constants.js';

export class HomeyError extends Error {
  /**
   * @param {'auth'|'forbidden'|'notfound'|'api'|'network'|'certificate'|'timeout'|'http'|'redirect'|'format'|'size'|'not-homey'} kind
   */
  constructor(kind, message, { status } = {}) {
    super(message);
    this.name = 'HomeyError';
    this.kind = kind;
    this.status = status;
  }
}

const NETWORK_REASONS = {
  ECONNREFUSED: 'connection refused',
  ECONNRESET: 'connection reset',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
  ENOTFOUND: 'unknown host name',
  EAI_AGAIN: 'host name not resolved',
  ETIMEDOUT: 'connection timed out',
  EPIPE: 'connection closed',
};

const CERTIFICATE_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** A socket error -> HomeyError (never the URL nor a header: they carry the key). */
export function networkError(err) {
  if (err instanceof HomeyError) {
    return err;
  }
  if (CERTIFICATE_CODES.has(err?.code)) {
    return new HomeyError('certificate', `certificate refused (${err.code})`);
  }
  const reason = NETWORK_REASONS[err?.code] ?? err?.code ?? 'network error';
  return new HomeyError('network', reason);
}

/**
 * One HTTP request; resolves { status, headers, body }.
 * @param {string} url
 * @param {{ method?: string, headers?: object, body?: string, timeout: number, agent?: http.Agent, maxBytes?: number }} options
 */
export function httpRequest(url, { method = 'GET', headers = {}, body, timeout, agent, maxBytes }) {
  const limit = maxBytes ?? LIMITS.responseBytes;
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let timer;
    let settled = false;
    /** The first outcome wins: a destroyed request may still end or fail after it. */
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const req = lib.request(
      target,
      { method, agent, headers: { Accept: 'application/json', ...headers } },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > limit) {
            const mb = Math.max(1, Math.round(limit / 1048576));
            settle(reject, new HomeyError('size', `answer larger than ${mb} MB`));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          settle(resolve, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', (err) => settle(reject, networkError(err)));
      },
    );
    timer = setTimeout(() => {
      const seconds = Math.max(1, Math.round(timeout / 1000));
      settle(reject, new HomeyError('timeout', `no answer within ${seconds} s`));
      req.destroy();
    }, timeout);
    req.on('error', (err) => settle(reject, networkError(err)));
    req.end(body);
  });
}

/** The reason Homey gave, short (error_description or error of its JSON). */
function reasonOf(json) {
  const text = json?.error_description ?? json?.error ?? json?.message;
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** The JSON of an answer (undefined for an empty one), or the HomeyError it carries. */
export function parseAnswer({ status, headers = {}, body }) {
  let json;
  try {
    json = body ? JSON.parse(body) : undefined;
  } catch {
    json = undefined;
  }
  if (status >= 300 && status < 400) {
    let where = headers.location ?? '';
    try {
      where = new URL(headers.location).origin;
    } catch {
      // A relative location: keep it as is.
    }
    throw new HomeyError('redirect', `redirected to ${where}`, { status });
  }
  if (status === 401) {
    throw new HomeyError('auth', reasonOf(json) || 'API key refused (HTTP 401)', { status });
  }
  if (status === 403) {
    // A missing permission of the API key: Homey names the scope.
    throw new HomeyError('forbidden', reasonOf(json) || 'access refused (HTTP 403)', { status });
  }
  if (status === 404) {
    throw new HomeyError('notfound', reasonOf(json) || 'not found (HTTP 404)', { status });
  }
  if (status >= 400) {
    const reason = reasonOf(json);
    throw new HomeyError('api', reason ? `${reason} (HTTP ${status})` : `HTTP ${status}`, {
      status,
    });
  }
  if (status < 200) {
    throw new HomeyError('http', `HTTP ${status}`, { status });
  }
  if (body && body.trim() !== '' && json === undefined) {
    throw new HomeyError('format', 'not a Homey API answer', { status });
  }
  return json;
}

/** The headers of the ping answer -> { id, version }, or not a Homey. */
export function homeyOf({ status, headers = {} }) {
  const id = headers['x-homey-id'];
  if (!id) {
    throw new HomeyError(
      'not-homey',
      status === 200 ? 'this address is not a Homey Pro' : `HTTP ${status}, not a Homey Pro`,
      { status },
    );
  }
  return {
    id: String(id),
    version: headers['x-homey-version'] ? String(headers['x-homey-version']) : undefined,
  };
}

/**
 * A client of one Homey.
 * @param {{ url: string, apiKey: string, request?: typeof httpRequest }} options
 */
export function createClient({ url, apiKey, request = httpRequest }) {
  const agent = new (url.startsWith('https:') ? https : http).Agent({
    keepAlive: true,
    maxSockets: 4,
  });
  const send = (path, options) => request(`${url}${path}`, { agent, ...options });
  const auth = { Authorization: `Bearer ${apiKey}` };
  let transaction = 0;

  return {
    url,
    /** Which Homey answers at this address (no key needed). */
    async ping({ timeout = TIMINGS.requestTimeout } = {}) {
      return homeyOf(await send(API.ping, { timeout }));
    },
    async get(path, { timeout = TIMINGS.requestTimeout } = {}) {
      return parseAnswer(await send(path, { timeout, headers: auth }));
    },
    async put(path, body, { timeout = TIMINGS.requestTimeout } = {}) {
      return parseAnswer(
        await send(path, {
          method: 'PUT',
          timeout,
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    },
    /** The devices, by id. */
    devices(options = { timeout: TIMINGS.inventoryTimeout }) {
      return this.get(API.devices, options);
    },
    /** The zones (rooms), by id. */
    zones(options) {
      return this.get(API.zones, options);
    },
    /** Sets one capability; Homey answers once the device driver took it. */
    setCapability(deviceId, capabilityId, value) {
      transaction += 1;
      return this.put(API.capability(deviceId, capabilityId), {
        value,
        transactionId: `gladys-${Date.now()}-${transaction}`,
      });
    },
    close() {
      agent.destroy();
    },
  };
}
