// test/plugins/asset-fallback.test.js — a missing art file goes to the mirror, and nothing else does.
//
// SP_ASSET_FALLBACK names a mirror (https://downcdn.example); an install that does not set it keeps the old 404,
// and a page or a data file never leaves this server even when it is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetFallback } from '../../server/http/static.js';

const base = 'https://downcdn.example';

test('assetFallback: only /assets and /fonts, only for an http(s) mirror', () => {
  assert.equal(assetFallback('/assets/char/avatar/a.png', { base }), `${base}/assets/char/avatar/a.png`);
  assert.equal(assetFallback('/fonts/Bender.woff2', { base }), `${base}/fonts/Bender.woff2`);
  assert.equal(assetFallback('/assets/a.png', { base: `${base}/` }), `${base}/assets/a.png`, 'a trailing slash is folded');
  for (const p of ['/', '/index.html', '/js/main.js', '/data/assets.json', '/shared/protocol.js', '/assetsx/a.png']) {
    assert.equal(assetFallback(p, { base }), null, p);
  }
  assert.equal(assetFallback('/assets/a.png', { base: '' }), null, 'off by default');
  assert.equal(assetFallback('/assets/a.png', { base: 'downcdn.example' }), null, 'a bare host is not a mirror');
  assert.equal(assetFallback('/assets/a.png', { base: 'ftp://x' }), null);
});
