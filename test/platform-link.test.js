// test/platform-link.test.js — the handshake platform link (server/platform.js) and its lobby wiring.
// The platform only answers one 302; nothing here may affect gameplay, so every failure path is asserted to leave the
// room working with its local invite code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatformLink, platformConfigFromEnv, PLATFORM_DISABLED } from '../server/platform.js';
import { Lobby, Room } from '../server/lobby.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

test('config: off by default, off on 0/off, p2p with a host node, direct with only an upstream', () => {
  assert.equal(platformConfigFromEnv({}), null);
  assert.equal(platformConfigFromEnv({ SP_PLATFORM_URL: 'off' }), null);
  assert.equal(platformConfigFromEnv({ SP_PLATFORM_URL: '0' }), null);
  assert.equal(platformConfigFromEnv({ SP_PLATFORM_URL: 'https://x.example/' }), null, 'nothing to advertise');
  const p2p = platformConfigFromEnv({ SP_PLATFORM_HOSTNODE: 'node-1', SP_PLATFORM_UPSTREAM: 'https://game.example/' });
  assert.deepEqual(p2p, { base: 'https://p2p.jiangjiangze.icu', hostNode: 'node-1', upstream: 'https://game.example', mode: 'p2p', token: '' });
  const direct = platformConfigFromEnv({ SP_PLATFORM_UPSTREAM: 'https://game.example/x' });
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.upstream, 'https://game.example');
  const tokened = platformConfigFromEnv({ SP_PLATFORM_HOSTNODE: 'node-1', SP_PLATFORM_TOKEN: ' s3cret ' });
  assert.equal(tokened.token, 's3cret', 'the create token is trimmed and kept', tokened.token);
  const custom = platformConfigFromEnv({ SP_PLATFORM_URL: 'https://p.example/', SP_PLATFORM_HOSTNODE: 'n' });
  assert.equal(custom.base, 'https://p.example');
});

test('register: one POST with the room code, cached, and a refresh after the window', async () => {
  const calls = [];
  let t = 1_000_000;
  const link = createPlatformLink({ base: 'https://p.example', hostNode: 'n1', upstream: 'https://g.example', mode: 'p2p' }, {
    log: quiet, now: () => t, refreshMs: 1000,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ roomId: 'r1', joinUrl: 'https://p.example/go/r1' }) };
    },
  });
  assert.deepEqual(await link.register('ab12'), { roomId: 'r1', joinUrl: 'https://p.example/go/r1' });
  assert.deepEqual(calls[0].body, { hostNode: 'n1', code: 'AB12', upstream: 'https://g.example' });
  await link.register('ab12');
  assert.equal(calls.length, 1, 'a fresh link is served from the cache');
  t += 2000;
  await link.register('ab12');
  assert.equal(calls.length, 2, 'past the refresh window it registers again');
});

test('register: a failing platform returns null, records the reason, and does not throw', async () => {
  const link = createPlatformLink({ base: 'https://p.example', hostNode: '', upstream: 'https://g.example', mode: 'direct' }, {
    log: quiet,
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'busy' }),
  });
  assert.equal(await link.register('cd34'), null);
  const status = link.status();
  assert.equal(status.enabled, true);
  assert.match(String(status.lastError), /503/);
  assert.equal(status.rooms, 0);
});

test('lobby: a created room publishes its invite link; a solo room and a failure keep it null', async () => {
  const lobby = new Lobby({ registry: null, log: quiet, getData: () => ({ modes: {} }), options: {} });
  const broadcasts = [];
  lobby.broadcastState = (room) => broadcasts.push(room.toState());
  const rooms = [];
  lobby.platform = {
    register: async (code) => (code === 'OK12' ? { roomId: 'r', joinUrl: 'https://p.example/go/r' } : null),
    release: (code) => rooms.push(code),
  };
  const ok = new Room('OK12', 'coop', 'NORMAL', Date.now());
  lobby.announcePlatformRoom(ok);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ok.inviteUrl, 'https://p.example/go/r');
  assert.equal(ok.toState().inviteUrl, 'https://p.example/go/r');
  assert.ok(broadcasts.length >= 1, 'the room is rebroadcast once the link exists');

  const solo = new Room('SL12', 'solo', 'NORMAL', Date.now());
  lobby.announcePlatformRoom(solo);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(solo.inviteUrl, null, 'a solo room needs no invite link');

  const bad = new Room('BA12', 'coop', 'NORMAL', Date.now());
  lobby.announcePlatformRoom(bad);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(bad.inviteUrl, null, 'a failed registration keeps the local link');
  assert.equal(bad.toState().inviteUrl, undefined, 'no key in room.state when there is no link');

  lobby.disposeRoom(ok, 'test');
  assert.deepEqual(rooms, ['OK12'], 'disposing the room releases the platform entry');
});

test('create token: sent as Bearer on register and release; absent when the platform asks for none', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers });
    return { ok: true, json: async () => ({ roomId: 'r9', joinUrl: 'https://p.example/go/r9' }) };
  };
  const tokened = createPlatformLink({ base: 'https://p.example', hostNode: 'n1', upstream: '', mode: 'p2p', token: 's3cret' }, { log: quiet, fetchImpl });
  await tokened.register('tt12');
  tokened.release('tt12');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen[0].headers.authorization, 'Bearer s3cret', 'register carries the token');
  assert.equal(seen[1].method, 'DELETE');
  assert.equal(seen[1].headers.authorization, 'Bearer s3cret', 'release carries the token');
  assert.equal(tokened.status().createToken, 'set');
  assert.equal(JSON.stringify(tokened.status()).includes('s3cret'), false, 'the diagnostics never report the token itself');

  const open = [];
  const plain = createPlatformLink({ base: 'https://p.example', hostNode: '', upstream: 'https://g.example', mode: 'direct', token: '' }, {
    log: quiet,
    fetchImpl: async (url, init) => { open.push({ url, init }); return { ok: true, json: async () => ({ roomId: 'r1', joinUrl: 'https://p.example/go/r1' }) }; },
  });
  await plain.register('op12');
  assert.equal('authorization' in open[0].init.headers, false, 'no header when no token is configured');
  assert.equal(plain.status().createToken, 'off');
});

test('the disabled answer is the documented shape', () => {
  assert.deepEqual(PLATFORM_DISABLED, { enabled: false });
});
