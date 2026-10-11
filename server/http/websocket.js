// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * WebSocket (ws) at /ws, maxPayload 64 KB, no per-message deflate → Network.handleConnection. Refused at the
//     upgrade: any path not listed below 404; per-network socket limit for internet clients (maxConnectionsPerAddr,
//     see net.js clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.
//   * the same upgrade event also answers the host's lane table (DESIGN §28.30, server/http/wsLanes.js): other exact
//     paths the operator registered, each handing the socket to code the operator installed. No lanes (the default,
//     and the only thing a plain `npm start` has) ⇒ /ws accepted and every other path 404, exactly as before.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { createModDispatch } from '../modDispatch.js';
import { splitUrl } from './common.js';
import { netOptionsFrom, lobbyOptionsFrom } from './config.js';
import { validateLanes, resolveLane } from './wsLanes.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, [option: string]: any }} opts startServer() options
 * @param {{ data: object, log: object }} deps the game data the lobby's matches use, the logger
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network }}
 */
export function createSessionStack(opts, { data, log }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  const lobby = new Lobby({
    registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions,
    // 创意工坊 (docs/WORKSHOP.md): the behaviour layer of the installed packs travels with every match this lobby starts
    workshop: opts.workshop,
  });
  // 包声明的**分发前钩子**（DESIGN §28.13, server/modDispatch.js）: assembled here, because it needs the framework's
  // own send helper and the Network it belongs to. `send` is late-bound to `network` on purpose — it must be
  // `network.reply` (the send path with the backpressure guards), never a second write path on the raw socket.
  // No pack declares `server.preDispatch` ⇒ `createModDispatch` returns null ⇒ Network gets neither option and its
  // onFrame behaves byte-for-byte as before.
  let network;
  const modDispatch = createModDispatch({
    hooks: opts.workshop && opts.workshop.hooks,
    send: (conn, msg) => network.reply(conn, msg),
    log,
  });
  network = new Network({
    registry, handler: lobby, log,
    options: modDispatch ? { ...netOptions, preDispatch: modDispatch.preDispatch, onConnection: modDispatch.onConnection } : netOptions,
  });
  return { registry, lobby, network };
}
/**
 * Serve the WebSocket endpoints on `server` (its 'upgrade' event): the game's own /ws, plus the host's lanes.
 *
 * A lane is a second protocol on the same port and the same listener. It gets no privileges with this change:
 * admission (per-address and server-wide caps, `Network.admission`) runs for a lane exactly as it runs for /ws, so
 * registering a path is not a way to serve more sockets per address, and a lane is never a fallback — a request that
 * does not match a registered path is answered 404, it is not quietly handed to the game.
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, lanes?: readonly import('./wsLanes.js').WsLane[] }} deps
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, lanes }) {
  // A bad table is a configuration error, and it fails here — at boot, named — rather than leaving the operator
  // with a lane that answers 404 forever (the silent-revert shape this family has been burned by before).
  const table = validateLanes(lanes ?? []);
  if (table.problems.length) throw new Error(`bad ws lane table: ${table.problems.join('; ')}`);
  if (table.lanes.length) log.info(`[ws] lanes: ${table.lanes.map((l) => `${l.path} (${l.id})`).join(', ')}`);

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts) { reject(404, 'Not Found'); return; }
    const lane = parts.rawPath === '/ws' ? null : resolveLane(parts.rawPath, table.lanes);
    if (!lane && parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    if (lane) {
      // The lane owns the socket from here. Anything it throws closes that socket and says which lane said it —
      // falling through to /ws would let a client ask for `/duel/lobby` and land in a Stronghold match.
      try { lane.onUpgrade(req, socket, head, { reject, log, lane }); } catch (e) {
        log.error(`[ws] lane ${lane.id} failed`, e);
        socket.destroy();
      }
      return;
    }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
