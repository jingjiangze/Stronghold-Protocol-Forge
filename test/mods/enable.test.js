// test/mods/ — the manager's enable switch: `plugins/config.json` → `default`, one plugin at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createMods, nextDefault } from '../../server/mods/index.js';
import { loadStudioKey } from '../../server/studio/key.js';
import { modPage } from '../../server/mods/page.js';
import { MOD_PAGE_SCRIPT } from '../../server/mods/pageScript.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mods-enable-'));

// The registry the manager reads: two installed plugins. The real one is createPluginRegistry's.
const REGISTRY = {
  plugins: () => [
    { id: 'demo', manifest: { name: 'Demo', version: '1.0.0' }, class: 'content', status: 'loaded' },
    { id: 'other', manifest: { name: 'Other', version: '2.0.0' }, class: 'cosmetic', status: 'loaded' },
  ],
};

/** One request through the manager, with a loopback peer and a local Host (studio/gate.js). */
function call(mods, { method = 'POST', url = '/mod/enable', body, key = '' } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress: '127.0.0.1' };
  req.headers = { host: 'localhost:3000', 'content-type': 'application/json', ...(key ? { 'x-sp-mod': key } : {}) };
  let out = null;
  const res = {
    writeHead(status, headers) { out = { status, headers }; },
    end(buf) {
      if (!buf) return;
      // The refused writes answer an HTML error page (server/http/common.js sendError), the accepted ones JSON.
      out.body = /json/i.test(String(out.headers['Content-Type'] || '')) ? JSON.parse(String(buf)) : String(buf);
    },
  };
  return mods.handle(req, res, url, '').then(() => out);
}

test('nextDefault: on adds once, off removes, the rest of the list is kept', () => {
  assert.deepEqual(nextDefault([], 'demo', true), ['demo']);
  assert.deepEqual(nextDefault(['demo'], 'demo', true), ['demo']);
  assert.deepEqual(nextDefault(['demo', 'other'], 'demo', false), ['other']);
  assert.deepEqual(nextDefault(undefined, 'demo', true), ['demo']);
});

test('enable: the switch writes the policy default and keeps the owner\'s other fields', async () => {
  const dir = tmp();
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ rooms: 'fixed', allow: ['demo'], maxSets: 2 }, null, 2) + '\n');
  const mods = createMods({ root: dir, pluginsDir: dir, dataDir: dir, registry: REGISTRY, autoInbox: false });
  const { key } = loadStudioKey(dir);
  try {
    const on = await call(mods, { body: { id: 'demo', on: true }, key });
    assert.equal(on.status, 200);
    assert.deepEqual(on.body.default, ['demo']);
    assert.equal(on.body.rooms, 'fixed');
    let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved, { rooms: 'fixed', allow: ['demo'], maxSets: 2, default: ['demo'] });

    const off = await call(mods, { body: { id: 'demo', on: false }, key });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.default, []);
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved, { rooms: 'fixed', allow: ['demo'], maxSets: 2, default: [] });

    const status = await call(mods, { method: 'GET', url: '/mod/status.json' });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.default, []);
    assert.equal(status.body.plugins.find((p) => p.id === 'demo').enabled, false);
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('enable: a write needs the key; an unknown id is refused', async () => {
  const dir = tmp();
  const mods = createMods({ root: dir, pluginsDir: dir, dataDir: dir, registry: REGISTRY, autoInbox: false });
  const { key } = loadStudioKey(dir);
  try {
    assert.equal((await call(mods, { body: { id: 'demo', on: true } })).status, 403);
    assert.equal((await call(mods, { body: { id: 'missing', on: true }, key })).status, 404);
    const args = await call(mods, { body: { id: 'demo' }, key });
    assert.equal(args.status, 400);
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), false);
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the /mod page carries the switch for every row', () => {
  const page = modPage({ inbox: '/x/mod-inbox', keyHint: '/x/plugins/.studio-key' });
  // 站点 CSP 只哈希 importmap：脚本必须以外部文件（/mod/page.js）加载，页面里不许再出现内联脚本体。
  assert.match(page, /<script src="\/mod\/page\.js"><\/script>/);
  assert.doesNotMatch(page, /<script>\s*\(\(\)/, 'no inline script: siteCsp() would block it');
  assert.match(MOD_PAGE_SCRIPT, /\/mod\/enable/, 'the external script still wires the enable switch');
  assert.match(MOD_PAGE_SCRIPT, /data-toggle/, 'the external script still builds one row per plugin');
});
