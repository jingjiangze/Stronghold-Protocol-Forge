// WebSocket permessage-deflate: the engine's default is the vendored `on` preset (context takeover, the
// zlib default window negotiated, a 64-byte threshold). A large frame goes out compressed, a small one
// stays plain, a client without the extension gets plain frames, an offer that caps the server window is
// negotiated (not dropped), and the real server publishes the effective value on `welcome.transport`.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { attachWebSocket, narrowDeflateOffer, WS_DEFLATE } from '../server/http/websocket.js';
import { startServer } from '../server/index.js';

const BIG = JSON.stringify({ t: 'm.public', players: Array.from({ length: 200 }, (_, i) => ({ playerId: `p_${i % 4}`, name: '阿米娅', lp: 30, phase: 'PREP' })) });
const SMALL = JSON.stringify({ t: 'pong', at: 12345 });

/** A bare http server whose /ws sends BIG then SMALL to every socket (a stand-in for net.js Network). */
async function fakeServer() {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const network = {
    admission: () => null,
    handleConnection: (ws) => { ws.send(BIG); ws.send(SMALL); },
  };
  const wss = attachWebSocket(server, { network, log: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `ws://127.0.0.1:${server.address().port}/ws`, close: () => new Promise((r) => { wss.close(); server.close(() => r()); }) };
}

/** Connect, collect two messages, report the server's Sec-WebSocket-Extensions answer and the bytes the socket read. */
function receive(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts);
    const msgs = [];
    let negotiated = '';
    ws.on('upgrade', (res) => { negotiated = res.headers['sec-websocket-extensions'] || ''; });
    ws.on('error', reject);
    ws.on('message', (data) => {
      msgs.push(String(data));
      if (msgs.length === 2) {
        const read = ws._socket.bytesRead;
        ws.close();
        resolve({ msgs, read, extensions: negotiated });
      }
    });
  });
}

/** Resolve with the first decoded message of `type`, or reject after 10 s. */
function nextMessage(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 10_000);
    const onMessage = (data) => {
      const msg = JSON.parse(String(data));
      if (msg && msg.t === type) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
    ws.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

const open = (ws) => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

describe('WebSocket permessage-deflate', () => {
  let srv;
  before(async () => { srv = await fakeServer(); });
  after(async () => { await srv.close(); });

  test('negotiated with context takeover and no pinned window; a large frame is compressed', async () => {
    const r = await receive(srv.url);
    assert.match(r.extensions, /permessage-deflate/);
    assert.ok(!/server_no_context_takeover/.test(r.extensions),
      'context takeover must stay negotiated — that is the whole win');
    assert.ok(!/server_max_window_bits=/.test(r.extensions),
      'the window must stay undeclared, so a client that offers less still connects');
    assert.deepEqual(r.msgs, [BIG, SMALL], 'the payloads arrive intact');
    assert.ok(BIG.length > 10000);
    assert.ok(r.read < BIG.length / 4, `compressed on the wire: ${r.read} bytes read for ${BIG.length} of payload`);
    assert.equal(WS_DEFLATE.threshold, 64);
  });

  test('a client without the extension gets the same messages uncompressed', async () => {
    const r = await receive(srv.url, { perMessageDeflate: false });
    assert.equal(r.extensions, '');
    assert.deepEqual(r.msgs, [BIG, SMALL]);
    assert.ok(r.read > BIG.length + SMALL.length, `plain frames: ${r.read}`);
  });

  test('an offer that caps the server window is negotiated at that window, not dropped', async () => {
    const r = await receive(srv.url, { perMessageDeflate: { serverMaxWindowBits: 9 } });
    assert.match(r.extensions, /permessage-deflate/);
    assert.match(r.extensions, /server_max_window_bits=9/);
    assert.deepEqual(r.msgs, [BIG, SMALL]);
    // Nothing is pinned by the shipped preset, so the upgrade guard never has a reason to drop the header.
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=9'), false);
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=12; client_max_window_bits'), false);
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=9, permessage-deflate'), false);
    assert.equal(narrowDeflateOffer('permessage-deflate; client_max_window_bits'), false);
    assert.equal(narrowDeflateOffer(undefined), false);
    // A host that explicitly pins a window still gets the guard.
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=9', 11), true);
    assert.equal(narrowDeflateOffer('permessage-deflate; server_max_window_bits=12', 11), false);
  });
});

test('the real server negotiates compression at /ws, reports it on welcome, and keeps the 64 KB limit', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await open(ws);
    assert.match(ws.extensions, /permessage-deflate/);
    ws.send(JSON.stringify({ t: 'hello', name: 'probe' }));
    const welcome = await nextMessage(ws, 'welcome');
    assert.deepEqual(welcome.transport, { deflate: true, params: null, maxPayload: 64 * 1024, threshold: 64 });
    ws.close();

    // a compressed client frame whose inflated size is over the limit closes the socket (1009), like a plain one
    const big = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await open(big);
    const closed = new Promise((resolve) => big.once('close', (code) => resolve(code)));
    big.send(JSON.stringify({ t: 'hello', name: 'x'.repeat(70 * 1024) }));
    assert.equal(await closed, 1009);
  } finally {
    await srv.close();
  }
});
