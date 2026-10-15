// -----------------------------------------------------------------------------
// The realtime events of Homey: Socket.IO 2 (Engine.IO 3) over the WebSocket
// of Node.js, the protocol node-homey-api speaks through socket.io-client 2.
// Written here rather than depending on that client: it pulls a dozen
// packages with an open advisory (parseuri ReDoS) for ~200 lines of protocol.
//
// The sequence (Homey Web API "Socket.io specification", and the SocketSession
// of athombv/node-homey-api, read as documentation):
//   1. ws://<homey>/socket.io/?EIO=3&transport=websocket
//      <- 0{"sid","pingInterval","pingTimeout"}         Engine.IO open
//      <- 40                                             root namespace joined
//   2. -> 420["handshakeClient",{"token":<API key>,"homeyId":<id>}]
//      <- 430[null,{"namespace":"/api",…}]               or [error]
//   3. -> 40/api,          <- 40/api,                    or 44/api,"reason"
//   4. -> 42/api,1["subscribe","homey:device:<id>"]      <- 43/api,1[null]
//      <- 42/api,["homey:device:<id>","capability",{capabilityId, value,…}]
// Engine.IO 3: the client pings ("2") every pingInterval and the server
// answers "3" within pingTimeout, or the connection is dead.
// -----------------------------------------------------------------------------

import { REALTIME, TIMINGS } from './constants.js';

/** Socket.IO packet types. */
export const PACKET = {
  CONNECT: 0,
  DISCONNECT: 1,
  EVENT: 2,
  ACK: 3,
  ERROR: 4,
  BINARY_EVENT: 5,
  BINARY_ACK: 6,
};

export class RealtimeError extends Error {
  /** @param {'auth'|'forbidden'|'refused'|'timeout'|'closed'|'network'} kind */
  constructor(kind, message) {
    super(message);
    this.name = 'RealtimeError';
    this.kind = kind;
  }
}

/** One Socket.IO packet, as an Engine.IO message ("4" + packet). */
export function encodePacket({ type, nsp = '/', id, data }) {
  let text = `4${type}`;
  if (nsp && nsp !== '/') {
    text += `${nsp},`;
  }
  if (id !== undefined) {
    text += id;
  }
  if (data !== undefined) {
    text += JSON.stringify(data);
  }
  return text;
}

/**
 * One Socket.IO packet (the Engine.IO "4" removed): type, namespace, ack id,
 * data. Undefined when it cannot be read.
 */
export function decodePacket(text) {
  const type = Number(text[0]);
  if (!Number.isInteger(type) || type < PACKET.CONNECT || type > PACKET.BINARY_ACK) {
    return undefined;
  }
  let i = 1;
  if (type === PACKET.BINARY_EVENT || type === PACKET.BINARY_ACK) {
    // "<attachments>-": Homey sends no binary; the attachments are not read.
    const dash = text.indexOf('-', i);
    if (dash < 0) {
      return undefined;
    }
    i = dash + 1;
  }
  let nsp = '/';
  if (text[i] === '/') {
    const comma = text.indexOf(',', i);
    nsp = text.slice(i, comma < 0 ? text.length : comma);
    i = comma < 0 ? text.length : comma + 1;
  }
  let id;
  const digits = /^\d+/.exec(text.slice(i));
  if (digits) {
    id = Number(digits[0]);
    i += digits[0].length;
  }
  let data;
  if (i < text.length) {
    try {
      data = JSON.parse(text.slice(i));
    } catch {
      return undefined;
    }
  }
  return { type, nsp, id, data };
}

/** The error of a handshake or subscribe acknowledgment. */
export function refusal(err) {
  const status = Number(err?.statusCode ?? err?.code);
  const text =
    typeof err === 'string'
      ? err
      : (err?.error_description ?? err?.message ?? err?.error ?? 'refused by Homey');
  const message = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
  if (status === 401) {
    return new RealtimeError('auth', message);
  }
  return new RealtimeError(status === 403 ? 'forbidden' : 'refused', message);
}

/**
 * Opens the realtime session of one Homey; resolves once its namespace is
 * joined. Events reach `onEvent(uri, event, data)`; `onClose(reason)` is
 * called once when an open session is lost (never after `close()`).
 * @param {{ url: string, token: string, homeyId: string, WebSocket?: typeof WebSocket, timers?: object, timeout?: number, onEvent?: Function, onClose?: Function }} options
 * @returns {Promise<{ subscribe(uri: string): Promise<void>, close(): void }>}
 */
export function openRealtime({
  url,
  token,
  homeyId,
  WebSocket = globalThis.WebSocket,
  timers = globalThis,
  timeout = TIMINGS.realtimeTimeout,
  onEvent = () => {},
  onClose = () => {},
}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(`${url.replace(/^http/i, 'ws')}${REALTIME.path}`);
    } catch (err) {
      reject(new RealtimeError('network', err?.message ?? 'cannot open the socket'));
      return;
    }
    let namespace;
    let handshaking = false;
    let ready = false;
    let done = false;
    let nextId = 0;
    /** ack id -> { resolve, reject, timer } */
    const acks = new Map();
    let pingTimer;
    let pongTimer;
    let openTimer;

    const send = (text) => {
      if (!done && ws.readyState === 1) {
        ws.send(text);
      }
    };

    /** Everything stops once; the first reason wins. */
    function finish(reason, error, { notify = true } = {}) {
      if (done) {
        return;
      }
      done = true;
      timers.clearTimeout(openTimer);
      timers.clearInterval(pingTimer);
      timers.clearTimeout(pongTimer);
      for (const ack of acks.values()) {
        timers.clearTimeout(ack.timer);
        ack.reject(new RealtimeError('closed', reason));
      }
      acks.clear();
      try {
        ws.close();
      } catch {
        // Already closed.
      }
      if (!ready) {
        reject(error ?? new RealtimeError('closed', reason));
      } else if (notify) {
        onClose(reason);
      }
    }

    openTimer = timers.setTimeout(() => {
      const seconds = Math.round(timeout / 1000);
      finish('timeout', new RealtimeError('timeout', `no realtime session within ${seconds} s`));
    }, timeout);

    /** Emits an event and resolves with the arguments of its acknowledgment. */
    function call(nsp, event, ...args) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveAck, rejectAck) => {
        const timer = timers.setTimeout(() => {
          acks.delete(id);
          rejectAck(new RealtimeError('timeout', `${event}: no answer from Homey`));
        }, timeout);
        acks.set(id, { resolve: resolveAck, reject: rejectAck, timer });
        send(encodePacket({ type: PACKET.EVENT, nsp, id, data: [event, ...args] }));
      });
    }

    async function handshake() {
      const [err, result] = await call('/', 'handshakeClient', { token, homeyId });
      if (err !== null && err !== undefined) {
        throw refusal(err);
      }
      const given = result?.namespace;
      namespace = typeof given === 'string' && given.startsWith('/') ? given : '/api';
      send(encodePacket({ type: PACKET.CONNECT, nsp: namespace }));
    }

    const session = {
      async subscribe(uri) {
        const [err] = await call(namespace, 'subscribe', uri);
        if (err !== null && err !== undefined) {
          throw refusal(err);
        }
      },
      close() {
        finish('closed', undefined, { notify: false });
      },
    };

    function onPacket(packet) {
      if (!packet) {
        return;
      }
      switch (packet.type) {
        case PACKET.CONNECT:
          if (packet.nsp === '/' && !handshaking) {
            handshaking = true;
            handshake().catch((err) => finish(err.message, err));
          } else if (namespace && packet.nsp === namespace && !ready) {
            ready = true;
            timers.clearTimeout(openTimer);
            resolve(session);
          }
          return;
        case PACKET.ACK: {
          const ack = acks.get(packet.id);
          if (ack) {
            acks.delete(packet.id);
            timers.clearTimeout(ack.timer);
            ack.resolve(Array.isArray(packet.data) ? packet.data : [packet.data]);
          }
          return;
        }
        case PACKET.ERROR:
          finish('refused', refusal(packet.data));
          return;
        case PACKET.DISCONNECT:
          if (packet.nsp === '/' || packet.nsp === namespace) {
            finish('disconnected by Homey');
          }
          return;
        case PACKET.EVENT:
          if (ready && packet.nsp === namespace && Array.isArray(packet.data)) {
            const [uri, event, data] = packet.data;
            if (typeof uri === 'string') {
              onEvent(uri, event, data);
            }
          }
          return;
        default:
        // Binary packets: Homey sends none.
      }
    }

    function onOpen(text) {
      let info = {};
      try {
        info = JSON.parse(text);
      } catch {
        // Defaults below.
      }
      const interval = Number(info.pingInterval) > 0 ? Number(info.pingInterval) : 25_000;
      const wait = Number(info.pingTimeout) > 0 ? Number(info.pingTimeout) : 20_000;
      timers.clearInterval(pingTimer);
      pingTimer = timers.setInterval(() => {
        send('2');
        if (!pongTimer) {
          pongTimer = timers.setTimeout(() => finish('no answer to the ping'), wait);
        }
      }, interval);
    }

    function onMessage(event) {
      const text = event?.data;
      if (typeof text !== 'string' || text === '') {
        return;
      }
      switch (text[0]) {
        case '0':
          onOpen(text.slice(1));
          return;
        case '1':
          finish('closed by Homey');
          return;
        case '2':
          send(`3${text.slice(1)}`); // a server ping (Engine.IO 4 servers)
          return;
        case '3':
          timers.clearTimeout(pongTimer);
          pongTimer = undefined;
          return;
        case '4':
          onPacket(decodePacket(text.slice(1)));
          return;
        default:
        // "6" noop, "5" upgrade: nothing to do.
      }
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', () => finish('connection closed'));
    ws.addEventListener('error', (event) => {
      const reason =
        event?.message ||
        event?.error?.message ||
        (ready ? 'connection lost' : 'connection failed');
      finish(reason, new RealtimeError('network', reason));
    });
  });
}
