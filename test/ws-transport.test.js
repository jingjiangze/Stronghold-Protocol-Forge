// The engine's binding of stronghold-ws-compression: the mode → option set decision, the read-only
// `welcome.transport` shape, and the message-type whitelist on the send path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { attachWebSocket } from '../server/http/websocket.js';
import { send } from '../server/net.js';
import { startServer } from '../server/index.js';
import {
  resolveWsTransport, resolveWsCompression, describeWsCompression,
  isCompressibleType, compressibleTypes, wsCompressionMode, WS_COMPRESSION_MODES,
} from '../server/wsCompression.js';

const open = (ws) => new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });

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

test('the mode table and the env names: unset means on (this engine compressed by default before this layer)', () => {
  assert.deepEqual([...WS_COMPRESSION_MODES], ['off', 'on', 'safe']);
  assert.equal(wsCompressionMode({}), 'on');
  assert.equal(wsCompressionMode({ WS_COMPRESSION: 'off' }), 'off');
  assert.equal(wsCompressionMode({ SP_WS_COMPRESSION: 'safe' }), 'safe');
  assert.equal(wsCompressionMode({ WS_COMPRESSION: 'safe', SP_WS_COMPRESSION: 'off' }), 'safe', 'the new name wins');
});

test('off / on / safe resolve to the vendored option sets and the welcome shape', () => {
  const on = resolveWsTransport({ mode: 'on', maxPayload: 4096 });
  assert.equal(on.perMessageDeflate.threshold, 64);
  assert.equal(on.perMessageDeflate.clientNoContextTakeover, true);
  assert.ok(!('serverNoContextTakeover' in on.perMessageDeflate));
  assert.ok(!('serverMaxWindowBits' in on.perMessageDeflate));
  assert.deepEqual(on.transport, { deflate: true, params: null, maxPayload: 4096, threshold: 64 });

  const off = resolveWsTransport({ mode: 'off', maxPayload: 4096 });
  assert.equal(off.perMessageDeflate, false);
  assert.deepEqual(off.transport, { deflate: false, params: null, maxPayload: 4096, threshold: null });

  const safe = resolveWsTransport({ mode: 'safe' });
  assert.equal(safe.perMessageDeflate.serverNoContextTakeover, true);

  assert.throws(() => resolveWsTransport({ mode: 'ON' }), /must be one of/);
  assert.equal(resolveWsCompression('off'), false);
  assert.match(describeWsCompression('on').summary, /threshold 64/);
});

test('the whitelist: hot match frames compress, welcome and control frames do not', () => {
  for (const t of ['b.snap', 'b.ev', 'm.field', 'm.public', 'm.private', 'm.result', 'b.start', 'room.state']) {
    assert.equal(isCompressibleType(t), true, t);
  }
  for (const t of ['welcome', 'ok', 'error', 'pong', 'hello', undefined, null]) {
    assert.equal(isCompressibleType(t), false, String(t));
  }
  assert.ok(compressibleTypes().includes('b.start'), 'the extra switch compresses b.start by default');
});

/** Send one message of `type` through the real send path; return the bytes the client read. */
async function wireBytesFor(type, payload) {
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const network = { admission: () => null, handleConnection: (ws) => { send(ws, { t: type, data: payload }); } };
  const wss = attachWebSocket(server, { network, log: { error() {} } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
  try {
    const message = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
      ws.once('message', () => {
        clearTimeout(timer);
        resolve(ws._socket.bytesRead);
      });
      ws.once('error', reject);
    });
    await open(ws);
    return await message;
  } finally {
    try { ws.close(); } catch { /* gone */ }
    await new Promise((r) => { wss.close(); server.close(() => r()); });
  }
}

test('the send path applies the whitelist: a 5 KB welcome stays plain, a 5 KB m.public compresses', async () => {
  const payload = 'x'.repeat(5000);
  const welcome = await wireBytesFor('welcome', payload);
  const pub = await wireBytesFor('m.public', payload);
  assert.ok(welcome > 4000, `welcome must stay uncompressed: ${welcome} bytes`);
  assert.ok(pub < 1000, `m.public must compress: ${pub} bytes`);
});

test('WS_COMPRESSION=off / safe reach the real server, not just the resolver', async () => {
  const prev = process.env.WS_COMPRESSION;
  try {
    process.env.WS_COMPRESSION = 'off';
    let srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      let negotiated = '';
      ws.on('upgrade', (res) => { negotiated = res.headers['sec-websocket-extensions'] || ''; });
      await open(ws);
      assert.equal(negotiated, '', 'off must not negotiate an extension');
      ws.send(JSON.stringify({ t: 'hello', name: 'off-probe' }));
      const welcome = await nextMessage(ws, 'welcome');
      assert.deepEqual(welcome.transport, { deflate: false, params: null, maxPayload: 64 * 1024, threshold: null });
      ws.close();
    } finally { await srv.close(); }

    process.env.WS_COMPRESSION = 'safe';
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
      let negotiated = '';
      ws.on('upgrade', (res) => { negotiated = res.headers['sec-websocket-extensions'] || ''; });
      await open(ws);
      assert.match(negotiated, /permessage-deflate/);
      assert.match(negotiated, /server_no_context_takeover/, 'safe drops the server context, keeping the window negotiated');
      ws.close();
    } finally { await srv.close(); }
  } finally {
    if (prev === undefined) delete process.env.WS_COMPRESSION;
    else process.env.WS_COMPRESSION = prev;
  }
});
