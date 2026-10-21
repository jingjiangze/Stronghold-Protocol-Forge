// test/mods/http.test.js — the mod manager's two writes, at the HTTP layer.
//
// FORGE-COMPAT.md §5 listed this as a hole: `/mod/upload` and `/mod/fetch` had no test that actually sends a
// request — the old ones only asserted `handles()` returns true and that the page mentions the paths. Every
// refusal below (method, cross-site, key, body size, JSON, url, sha256, download, digest) is a branch of
// `server/mods/index.js` that could rot without a red.
//
// No network: the download cases inject `fetch`, and `fetchHttps` skips DNS pinning when a fetch is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { PLUGIN_LIMITS } from '../../shared/plugins/manifest.js';
import { createMods } from '../../server/mods/index.js';
import { readVanillaAssets } from '../../server/plugins/registry.js';
import { zipFiles } from '../../server/plugins/zip.js';
import { studioMode } from '../../server/studio/gate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vanilla = readVanillaAssets(path.join(ROOT, 'data'));
const DATA = path.join(ROOT, 'data');

/** A minimal plugin that passes the zip, layout and manifest checks (the same shape test/plugins/install.test.js uses). */
function pluginZip(id, manifestExtra = {}, files = {}) {
  const manifest = {
    manifest: 2, id, name: { zh: '测试', en: 'Test' }, version: '1.0.0', app: '*', api: 1,
    class: 'cosmetic', scope: ['room', 'personal'], permissions: ['assets.override'], assets: {},
    ...manifestExtra,
  };
  // Root-level entries: `sniffArchive` looks for plugin.json at the top of the zip (the layout
  // `tools/mod.mjs pack` produces). A zip that wraps everything in `<id>/` is a separate open question — see
  // the note in FORGE-COMPAT.md; it is not asserted here in either direction.
  const entries = [{ name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) }];
  for (const [rel, data] of Object.entries(files)) {
    entries.push({ name: rel, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  }
  return zipFiles(entries);
}

function makeMods({ fetchImpl = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mod-http-'));
  const quiet = { info() {}, warn() {} };
  const mods = createMods({
    root: ROOT, pluginsDir: dir, dataDir: DATA, vanilla,
    autoInbox: false, log: quiet, fetch: fetchImpl,
  });
  const key = fs.readFileSync(path.join(dir, '.studio-key'), 'utf8').trim();
  return { mods, dir, key };
}

/**
 * One request through `mods.handle`, with the fake response csp.test.js already uses.
 * `body` may be a string, a Buffer or a raw header that cheats `content-length`.
 */
function call(mods, { method = 'POST', url = '/mod/upload', headers = {}, body = null, remote = '127.0.0.1' } = {}) {
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, done) { chunks.push(chunk); done(); } });
  const meta = { status: 0, headers: {} };
  res.writeHead = (status, fields) => { meta.status = status; for (const [k, v] of Object.entries(fields || {})) meta.headers[k.toLowerCase()] = v; };
  res.setHeader = (name, value) => { meta.headers[String(name).toLowerCase()] = value; };
  res.getHeader = (name) => meta.headers[String(name).toLowerCase()];
  const done = once(res, 'finish').then(() => ({ ...meta, body: Buffer.concat(chunks).toString('utf8') }));

  const req = Readable.from(body == null ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:3000', ...headers };
  req.socket = { remoteAddress: remote };

  const u = new URL(`http://127.0.0.1${url}`);
  Promise.resolve(mods.handle(req, res, u.pathname, u.search)).catch(() => { /* the handler answers on its own */ });
  return done;
}

test('/mod: the page and the status read are open; a write method is 405', async () => {
  const { mods, dir } = makeMods();
  try {
    let r = await call(mods, { method: 'GET', url: '/mod' });
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /text\/html/);
    assert.match(r.body, /\/mod\/upload/, 'the page still names the upload path');

    r = await call(mods, { method: 'POST', url: '/mod' });
    assert.equal(r.status, 405);

    r = await call(mods, { method: 'GET', url: '/mod/status.json' });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.ok(Array.isArray(j.plugins), 'the status lists plugins');
    assert.equal(j.inbox, mods.inboxDir, 'inbox is the folder the manager watches, not a count');
    assert.ok(j.inboxCount === null || typeof j.inboxCount === 'number', 'the count has its own field');

    r = await call(mods, { method: 'POST', url: '/mod/status.json' });
    assert.equal(r.status, 405);

    r = await call(mods, { method: 'GET', url: '/mod/nope' });
    assert.equal(r.status, 404);
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/mod/upload: method, cross-site, key and body size are refused before anything is read', async () => {
  const { mods, dir, key } = makeMods();
  try {
    let r = await call(mods, { method: 'GET', url: '/mod/upload', headers: { 'x-sp-mod': key } });
    assert.equal(r.status, 405);

    r = await call(mods, { method: 'POST', url: '/mod/upload', headers: { 'x-sp-mod': key, 'sec-fetch-site': 'cross-site' }, body: 'x' });
    assert.equal(r.status, 403);
    assert.match(r.body, /cross-site write refused/);

    r = await call(mods, { method: 'POST', url: '/mod/upload', headers: { 'x-sp-mod': key, origin: 'https://evil.example' }, body: 'x' });
    assert.equal(r.status, 403, 'a foreign Origin is refused even with the right key');
    assert.match(r.body, /cross-site write refused/);

    r = await call(mods, { method: 'POST', url: '/mod/upload', headers: { 'x-sp-mod': 'not-the-key' }, body: 'x' });
    assert.equal(r.status, 403);
    assert.match(r.body, /missing or wrong key/);

    r = await call(mods, { method: 'POST', url: '/mod/upload', body: 'x' });
    assert.equal(r.status, 403, 'no key at all is refused too');

    // The declared length is checked before a byte is buffered: no 200 MiB allocation here.
    r = await call(mods, {
      method: 'POST', url: '/mod/upload', body: 'x',
      headers: { 'x-sp-mod': key, 'content-length': String(PLUGIN_LIMITS.pluginBytes + 1) },
    });
    assert.equal(r.status, 413);
    assert.match(r.body, /body is larger/);

    assert.deepEqual(fs.readdirSync(dir).filter((n) => !n.startsWith('.')), [], 'no refusal wrote a plugin folder');
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/mod/upload: the right key installs the zip and answers with its own report', async () => {
  const { mods, dir, key } = makeMods();
  try {
    const zip = pluginZip('http-test-plugin', { app: '>=0.3.0 <0.4.0' });
    const r = await call(mods, {
      method: 'POST', url: '/mod/upload',
      headers: { 'x-sp-mod': key, 'content-type': 'application/zip', 'content-length': String(zip.length) },
      body: zip,
    });
    assert.equal(r.status, 200, r.body);
    assert.match(String(r.headers['content-type']), /application\/json/);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(j.kind, 'plugin');
    assert.equal(j.wrote, true);
    assert.equal(j.id, 'http-test-plugin');
    assert.ok(j.compat, 'the plugin branch reports its version verdict');
    assert.ok(fs.existsSync(path.join(dir, 'http-test-plugin', 'plugin.json')));

    // A second upload without force is the EXISTS branch, and it must answer 400 with the code, not a 500.
    const again = await call(mods, {
      method: 'POST', url: '/mod/upload',
      headers: { 'x-sp-mod': key, 'content-length': String(zip.length) }, body: zip,
    });
    assert.equal(again.status, 400);
    assert.equal(JSON.parse(again.body).error, 'PLUGIN_INSTALL_EXISTS');

    // force=1 replaces it.
    const forced = await call(mods, {
      method: 'POST', url: '/mod/upload?force=1',
      headers: { 'x-sp-mod': key, 'content-length': String(zip.length) }, body: zip,
    });
    assert.equal(forced.status, 200, forced.body);
    assert.equal(JSON.parse(forced.body).ok, true);
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/mod/upload: bytes that are not a plugin zip come back as a 400 report, never a 500', async () => {
  const { mods, dir, key } = makeMods();
  try {
    const junk = Buffer.from('this is not a zip');
    const r = await call(mods, {
      method: 'POST', url: '/mod/upload',
      headers: { 'x-sp-mod': key, 'content-length': String(junk.length) }, body: junk,
    });
    assert.equal(r.status, 400);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, false);
    assert.equal(j.error, 'PLUGIN_INSTALL_ZIP');
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/mod/fetch: gates, JSON, url and sha256 each have their own answer', async () => {
  let impl = async () => new Response('never called', { status: 500 });
  const { mods, dir, key } = makeMods({ fetchImpl: (...a) => impl(...a) });
  const post = (body, extra = {}) => call(mods, {
    method: 'POST', url: '/mod/fetch',
    headers: { 'x-sp-mod': key, 'content-type': 'application/json', ...extra },
    body,
  });
  try {
    let r = await call(mods, { method: 'GET', url: '/mod/fetch', headers: { 'x-sp-mod': key } });
    assert.equal(r.status, 405);

    r = await call(mods, { method: 'POST', url: '/mod/fetch', headers: { 'x-sp-mod': key, 'sec-fetch-site': 'cross-site' }, body: '{}' });
    assert.equal(r.status, 403);
    assert.match(r.body, /cross-site write refused/);

    r = await call(mods, { method: 'POST', url: '/mod/fetch', headers: { 'x-sp-mod': 'nope' }, body: '{}' });
    assert.equal(r.status, 403);
    assert.match(r.body, /missing or wrong key/);

    r = await post('not json');
    assert.equal(r.status, 400);
    assert.match(r.body, /body is not JSON/);

    r = await post('{}');
    assert.equal(r.status, 400);
    assert.match(r.body, /missing url/);

    r = await post(JSON.stringify({ url: 'https://public.example/a.zip', sha256: 'abc' }));
    assert.equal(r.status, 400);
    assert.match(r.body, /64 lowercase hex/);

    // A plain-http target never reaches the injected fetch (fetchHttps refuses it first).
    let reached = 0;
    impl = async () => { reached += 1; return new Response('x', { status: 200 }); };
    r = await post(JSON.stringify({ url: 'http://public.example/a.zip' }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).ok, false);
    assert.equal(JSON.parse(r.body).error, 'PLUGIN_INSTALL_URL');
    assert.equal(reached, 0, 'a refused target is refused before the fetch');

    // The digest is checked against the bytes that came back.
    const zip = pluginZip('fetch-test-plugin');
    impl = async () => new Response(zip, { status: 200 });
    r = await post(JSON.stringify({ url: 'https://public.example/a.zip', sha256: 'a'.repeat(64) }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, 'SHA256');
    assert.match(JSON.parse(r.body).detail, /^got [0-9a-f]{64}$/);

    // A 200 that is not a zip is still a 400 report.
    impl = async () => new Response('not a zip', { status: 200 });
    r = await post(JSON.stringify({ url: 'https://public.example/a.zip' }));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, 'PLUGIN_INSTALL_ZIP');

    // Correct digest, real zip: installed, and the report matches the upload one.
    impl = async () => new Response(zip, { status: 200 });
    const digest = createHash('sha256').update(zip).digest('hex');
    r = await post(JSON.stringify({ url: 'https://public.example/a.zip', sha256: digest }));
    assert.equal(r.status, 200, r.body);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, true);
    assert.equal(j.id, 'fetch-test-plugin');
    assert.ok(fs.existsSync(path.join(dir, 'fetch-test-plugin', 'plugin.json')));
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/mod/fetch: an oversized instruction body is 413 before it is parsed', async () => {
  const { mods, dir, key } = makeMods();
  try {
    const r = await call(mods, {
      method: 'POST', url: '/mod/fetch',
      headers: { 'x-sp-mod': key, 'content-length': String(64 * 1024 + 1) },
      body: '{}',
    });
    assert.equal(r.status, 413);
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('/mod: a peer that is not on this machine or the local network gets 404 for every path', async () => {
  if (studioMode() === 'off') return; // the whole surface is off in this environment; nothing to assert
  const { mods, dir, key } = makeMods();
  try {
    for (const url of ['/mod', '/mod/status.json', '/mod/upload', '/mod/fetch']) {
      const r = await call(mods, { method: 'GET', url, headers: { 'x-sp-mod': key }, remote: '8.8.8.8' });
      assert.equal(r.status, 404, `${url} from a public address`);
    }
    const r = await call(mods, { method: 'GET', url: '/mod', headers: { host: 'evil.example' } });
    assert.equal(r.status, 404, 'a foreign Host is refused');
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
