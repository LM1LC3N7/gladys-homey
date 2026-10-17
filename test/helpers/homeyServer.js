// A simulated Homey Pro on 127.0.0.1 (never the network): the local Web API
// over HTTP (ping, devices, zones, capability sets, the Bearer key) and the
// realtime socket, a minimal WebSocket server speaking Engine.IO 3 /
// Socket.IO 2 like Homey (open, root namespace, handshakeClient, /api,
// subscribe, capability events, pings). Its packet parser is written apart
// from src/realtime.js on purpose: the client is not checked against itself.

import { createHash } from 'node:crypto';
import http from 'node:http';
import { HOMEY_ID, HOMEY_VERSION, answers } from '../fixtures/homey.js';
import { KEY } from './fakeHomey.js';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** One server text frame (not masked). */
function frame(text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** The client frames (masked) of a growing buffer. */
function readFrames(state, chunk, onText, onClose) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  for (;;) {
    const b = state.buffer;
    if (b.length < 2) {
      return;
    }
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let length = b[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) {
        return;
      }
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) {
        return;
      }
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    const maskAt = offset;
    if (masked) {
      offset += 4;
    }
    if (b.length < offset + length) {
      return;
    }
    let payload = Buffer.from(b.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= b[maskAt + (i % 4)];
      }
    }
    state.buffer = b.subarray(offset + length);
    if (opcode === 1) {
      onText(payload.toString('utf8'));
    } else if (opcode === 8) {
      onClose();
    }
  }
}

/** "<type>[/nsp,][id][json]" -> { type, nsp, id, data } */
function parsePacket(text) {
  const match = /^(\d)(?:(\/[^,]*),)?(\d*)([\s\S]*)$/.exec(text);
  if (!match) {
    return undefined;
  }
  return {
    type: Number(match[1]),
    nsp: match[2] ?? '/',
    id: match[3] === '' ? undefined : Number(match[3]),
    data: match[4] === '' ? undefined : JSON.parse(match[4]),
  };
}

export async function homeyServer({ key = KEY, id = HOMEY_ID, version = HOMEY_VERSION } = {}) {
  const { devices, zones } = answers();
  const sim = {
    devices,
    zones,
    /** every HTTP request: { method, path, auth, body } */
    requests: [],
    /** the realtime connections */
    connections: [],
    zonesForbidden: false,
    /** Engine.IO settings sent at the open */
    pingInterval: 25_000,
    pingTimeout: 5000,
    answerPings: true,
    /** the upgrade is accepted but nothing is ever sent */
    mute: false,
    pings: 0,
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  sim.emit = (deviceId, capabilityId, value) => {
    const cap = sim.devices[deviceId].capabilitiesObj[capabilityId];
    cap.value = value;
    cap.lastUpdated = new Date().toISOString();
    const uri = `homey:device:${deviceId}`;
    const event = [
      uri,
      'capability',
      { capabilityId, value, transactionId: 'sim', transactionTime: Date.now() },
    ];
    for (const conn of sim.connections.filter((c) => c.subscribed.has(uri))) {
      conn.send(`42${conn.namespace},${JSON.stringify(event)}`);
    }
  };

  sim.drop = () => {
    for (const conn of sim.connections) {
      conn.socket.destroy();
    }
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const path = req.url;
      const auth = req.headers.authorization;
      const body = Buffer.concat(chunks).toString('utf8');
      sim.requests.push({ method: req.method, path, auth, body });
      if (req.method === 'GET' && path === '/api/manager/system/ping') {
        json(res, 200, true, { 'X-Homey-ID': id, 'X-Homey-Version': version });
        return;
      }
      if (auth !== `Bearer ${key}`) {
        json(res, 401, { error: 'invalid_token', error_description: 'Invalid Token' });
        return;
      }
      if (req.method === 'GET' && path === '/api/manager/devices/device') {
        json(res, 200, sim.devices);
        return;
      }
      if (req.method === 'GET' && path === '/api/manager/zones/zone') {
        if (sim.zonesForbidden) {
          json(res, 403, {
            error: 'Missing Scopes',
            error_description: 'Missing Scopes: homey.zone.readonly',
          });
          return;
        }
        json(res, 200, sim.zones);
        return;
      }
      const one = /^\/api\/manager\/devices\/device\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && one) {
        const device = sim.devices[decodeURIComponent(one[1])];
        if (!device) {
          json(res, 404, { error: 'not_found', error_description: 'Device Not Found' });
          return;
        }
        json(res, 200, device);
        return;
      }
      const set = /^\/api\/manager\/devices\/device\/([^/]+)\/capability\/([^/]+)$/.exec(path);
      if (req.method === 'PUT' && set) {
        const [deviceId, capabilityId] = [decodeURIComponent(set[1]), decodeURIComponent(set[2])];
        if (!sim.devices[deviceId]?.capabilitiesObj?.[capabilityId]) {
          json(res, 404, { error: 'not_found', error_description: 'Capability Not Found' });
          return;
        }
        sim.emit(deviceId, capabilityId, JSON.parse(body).value);
        json(res, 200, {});
        return;
      }
      json(res, 404, { error: 'not_found', error_description: 'Not Found' });
    });
  });

  function onPacket(conn, packet) {
    if (!packet) {
      return;
    }
    if (packet.type === 0 && packet.nsp !== '/') {
      if (conn.handshaken && packet.nsp === '/api') {
        conn.namespace = '/api';
        conn.send('40/api,');
      } else {
        conn.send(`44${packet.nsp},"Unauthorized"`);
      }
      return;
    }
    if (packet.type !== 2 || !Array.isArray(packet.data)) {
      return;
    }
    const [event, arg] = packet.data;
    const ack = (args) =>
      conn.send(
        `43${packet.nsp === '/' ? '' : `${packet.nsp},`}${packet.id}${JSON.stringify(args)}`,
      );
    if (packet.nsp === '/' && event === 'handshakeClient') {
      if (arg?.token === key && arg?.homeyId === id) {
        conn.handshaken = true;
        ack([null, { token: 'session-token', namespace: '/api', success: true }]);
      } else {
        ack([{ error: 'invalid_token', error_description: 'Invalid token', statusCode: 401 }]);
      }
    } else if (packet.nsp === '/api' && event === 'subscribe') {
      conn.subscribed.add(arg);
      ack([null]);
    }
  }

  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/socket.io/') || !req.url.includes('EIO=3')) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}${GUID}`)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    const conn = {
      socket,
      handshaken: false,
      namespace: undefined,
      subscribed: new Set(),
      received: [],
      send: (text) => {
        if (!socket.destroyed) {
          socket.write(frame(text));
        }
      },
    };
    sim.connections.push(conn);
    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk) =>
      readFrames(
        state,
        chunk,
        (text) => {
          conn.received.push(text);
          if (text === '2') {
            sim.pings += 1;
            if (sim.answerPings) {
              conn.send('3');
            }
          } else if (text.startsWith('4')) {
            onPacket(conn, parsePacket(text.slice(1)));
          }
        },
        () => socket.end(),
      ),
    );
    socket.on('error', () => {});
    if (!sim.mute) {
      conn.send(
        `0${JSON.stringify({ sid: `sid${sim.connections.length}`, upgrades: [], pingInterval: sim.pingInterval, pingTimeout: sim.pingTimeout })}`,
      );
      conn.send('40');
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  sim.url = `http://127.0.0.1:${server.address().port}`;
  sim.close = () =>
    new Promise((resolve) => {
      sim.drop();
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return sim;
}

/** Waits for a condition (real time), up to `ms`. */
export async function waitFor(condition, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
