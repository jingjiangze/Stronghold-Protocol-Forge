// test/plugins/client-entries.test.js — `/api/client-entries` (code.clientEntry): the list a plugin's browser module
// is loaded from. Empty when no plugin declares one (the endpoint still answers, so the host needs no special case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { createRequestHandler } from '../../server/http/routes.js';
import { createStaticHandler } from '../../server/http/static.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

/** One request through the real handler; `serveStatic` is a stub that never matches. */
function request(handler, url, method = 'GET') {
  const chunks = [], result = { headers: {}, status: 0 };
  const res = new Writable({ write(chunk, _e, done) { chunks.push(chunk); done(); } });
  res.setHeader = (name, value) => { result.headers[String(name).toLowerCase()] = value; };
  res.getHeader = (name) => result.headers[String(name).toLowerCase()];
  res.writeHead = (status, fields) => { result.status = status; for (const [k, v] of Object.entries(fields || {})) res.setHeader(k, v); };
  const done = once(res, 'finish').then(() => ({ ...result, body: Buffer.concat(chunks).toString('utf8') }));
  handler({ url, method, headers: { host: '127.0.0.1:3000' } }, res);
  return done;
}

const handlerOf = (clientEntries) => createRequestHandler({
  serveStatic: createStaticHandler({ publicDir: path.join(ROOT, 'public'), dataDir: path.join(ROOT, 'data'), sharedDir: path.join(ROOT, 'shared') }),
  health: {}, log: { info() {}, warn() {}, error() {} }, clientEntries,
});

test('/api/client-entries: no plugin declares one → an empty list, still 200 JSON', async () => {
  const r = await request(handlerOf([]), '/api/client-entries');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /application\/json/);
  assert.match(String(r.headers['cache-control']), /max-age=30/);
  assert.deepEqual(JSON.parse(r.body), { entries: [] });
});

test('/api/client-entries: the entries expose id + url only (no path on disk leaks)', async () => {
  const list = [{ id: 'room-chat', rel: 'js/ui/roomChat.js', url: '/js/ui/roomChat.js', mtimeMs: 1 }];
  const r = await request(handlerOf(list), '/api/client-entries');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { entries: [{ id: 'room-chat', url: '/js/ui/roomChat.js' }] });
  assert.ok(!r.body.includes('mtime'), 'mtimeMs is not serialized');
  assert.ok(!r.body.includes('rel'), 'rel is not serialized');
});

test('/api/client-entries: a plugin entry is served by the overlay, same origin (CSP script-src \'self\')', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-client-entry-'));
  try {
    const publicDir = path.join(dir, 'public');
    fs.mkdirSync(path.join(publicDir, 'js', 'ui'), { recursive: true });
    const overlay = new Map([['js/ui/roomChat.js', { body: Buffer.from('export function mount() {}'), type: 'text/javascript' }]]);
    const handler = createRequestHandler({
      serveStatic: createStaticHandler({ publicDir, dataDir: path.join(ROOT, 'data'), sharedDir: path.join(ROOT, 'shared'), clientOverlay: overlay }),
      health: {}, log: { info() {}, warn() {}, error() {} },
      clientEntries: [{ id: 'room-chat', rel: 'js/ui/roomChat.js', url: '/js/ui/roomChat.js', mtimeMs: 1 }],
    });
    const r = await request(handler, '/js/ui/roomChat.js');
    assert.equal(r.status, 200);
    assert.match(r.body, /export function mount/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
