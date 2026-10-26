// test/plugins/lobby-modules.test.js — the code.lobby surface (server/plugins/lobbyModules.js): a loaded trusted
// plugin that declares `code.lobby` mounts room-level hooks (protocol/on/roomInit/roomState/matchOptions/onRoom);
// with no such plugin the host sees no extensions object, so every room message stays byte-for-byte as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { C2S } from '../../shared/protocol.js';
import { mountLobbyPlugins } from '../../server/plugins/lobbyModules.js';

/** A registry double: the mount filter reads id / status / manifest.class / manifest.code / dir only. */
const registryOf = (list) => ({ plugins: () => list });

const fakeLobby = () => ({
  ext: 'unset',
  setExtensions(ext) { this.ext = ext || null; },
});

/** A plugin folder under `root`, with the module `src` as its code.lobby. */
function plugin(root, id, { klass = 'trusted', code = { lobby: 'server/lobby.js' }, src = 'export function setup() {}' } = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'lobby.js'), src);
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ manifest: 2, id, version: '1.0.0', class: klass }));
  return { id, status: 'loaded', class: klass, manifest: { class: klass, code }, dir };
}

const quiet = () => ({ info() {}, warn() {}, error() {} });

test('without a code.lobby plugin the host gets no extensions object', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobby-none-'));
  try {
    const lobby = fakeLobby();
    const dispose = await mountLobbyPlugins(lobby, registryOf([]), { log: quiet() });
    assert.equal(lobby.ext, null, 'no plugin → setExtensions(null)');
    await dispose();
    assert.equal(lobby.ext, null, 'dispose keeps the host clean');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the mount filter: only loaded trusted plugins that name code.lobby', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobby-filter-'));
  try {
    const lobby = fakeLobby();
    const list = [
      plugin(root, 'a-script', { klass: 'script' }),
      plugin(root, 'b-nocode', { code: { client: [] } }),
      { ...plugin(root, 'c-disabled'), status: 'disabled' },
      plugin(root, 'd-escape', { code: { lobby: '../outside.js' } }),
    ];
    await mountLobbyPlugins(lobby, registryOf(list), { log: quiet() });
    assert.equal(lobby.ext, null, 'none of the four mounts');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('setup(api) wires every hook and the host flattens what it returns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobby-hooks-'));
  const c2sBefore = Object.keys(C2S).length;
  try {
    const p = plugin(root, 'hooky', { src: `
      export async function setup(api) {
        api.protocol({ 'hooky.ping': {} });
        api.on('hooky.chat', () => 'handled');
        api.roomInit((room) => { room.hooky = { n: 1 }; });
        api.roomState((room) => ({ hookyN: room.hooky?.n ?? 0 }));
        api.matchOptions((room) => ({ hooky: room.hooky }));
        api.onRoom('created', (room) => { room.seen = 'created'; });
        return () => { globalThis.__hookyDisposed = true; };
      }` });
    const lobby = fakeLobby();
    const dispose = await mountLobbyPlugins(lobby, registryOf([p]), { log: quiet() });
    assert.ok(lobby.ext, 'the extensions object is mounted');
    assert.ok(Object.hasOwn(C2S, 'hooky.ping'), 'the plugin added its C2S key');
    assert.equal(lobby.ext.handlers.get('hooky.chat')({}, {}, {}, {}), 'handled');
    const room = {};
    lobby.ext.init(room);
    assert.deepEqual(room.hooky, { n: 1 }, 'roomInit runs against the room');
    assert.deepEqual(lobby.ext.state(room), { hookyN: 1 }, 'roomState flattens into room.state');
    assert.deepEqual(lobby.ext.options(room), { hooky: { n: 1 } }, 'matchOptions flattens into Match opts');
    lobby.ext.emit('created', room);
    assert.equal(room.seen, 'created', 'the room event ran');
    await dispose();
    assert.equal(globalThis.__hookyDisposed, true, 'the plugin disposer ran');
    assert.equal(lobby.ext, null, 'the host is clean again');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    delete C2S['hooky.ping'];
    delete globalThis.__hookyDisposed;
    assert.equal(Object.keys(C2S).length, c2sBefore, 'C2S is restored');
  }
});

test('api.protocol never overrides an engine key; a throwing module is logged and skipped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-lobby-guard-'));
  try {
    const guardy = plugin(root, 'guardy', { src: `
      export async function setup(api) {
        api.protocol({ 'room.chat': { hacked: () => true }, 'guardy.ok': {} });
      }` });
    const lobby = fakeLobby();
    await mountLobbyPlugins(lobby, registryOf([guardy]), { log: quiet() });
    assert.equal(Object.hasOwn(C2S['room.chat'], 'hacked'), false, 'the engine protocol table wins');
    assert.ok(Object.hasOwn(C2S, 'guardy.ok'), 'a new key is accepted');
    delete C2S['guardy.ok'];

    const bad = plugin(root, 'broken', { src: 'throw new Error("boom");' });
    const log = quiet();
    const seen = [];
    log.error = (m) => seen.push(String(m));
    const l2 = fakeLobby();
    await mountLobbyPlugins(l2, registryOf([bad]), { log });
    assert.equal(l2.ext, null, 'a throwing plugin does not mount');
    assert.ok(seen.some((m) => /failed/.test(m)), 'the failure was logged');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
