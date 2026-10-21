// test/mods/plugin-import.test.js — the plugin half of `importArchive`.
//
// The old suite only ever fed it a Forge pack and a zip with neither manifest: the
// `kind === 'plugin'` branch (dryRun, install, EXISTS, CHECK, the compat verdict) had no
// test at all, so a regression there would have stayed green. FORGE-COMPAT.md §5 carried
// this as an open hole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importArchive, sniffArchive } from '../../server/mods/import.js';
import { readVanillaAssets } from '../../server/plugins/registry.js';
import { zipFiles } from '../../server/plugins/zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = path.join(ROOT, 'data');
const vanilla = readVanillaAssets(DATA);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mod-plugin-'));
const opts = (pluginsDir) => ({ root: ROOT, pluginsDir, dataDir: DATA, vanilla });
// `.studio-key` and the manager's own `_incoming` staging root are not plugins.
const installed = (dir) => fs.readdirSync(dir).filter((n) => !/^[._]/.test(n)).sort();

/** Root-level `plugin.json`, the layout `tools/mod.mjs pack` and `sniffArchive` agree on. */
function pluginZip(id, manifestExtra = {}, files = {}) {
  const manifest = {
    manifest: 2, id, name: { zh: '测试', en: 'Test' }, version: '1.0.0', app: '*', api: 1,
    class: 'cosmetic', scope: ['room', 'personal'], permissions: ['assets.override'], assets: {},
    ...manifestExtra,
  };
  const entries = [{ name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) }];
  for (const [rel, data] of Object.entries(files)) {
    entries.push({ name: rel, data: Buffer.isBuffer(data) ? data : Buffer.from(data) });
  }
  return zipFiles(entries);
}

/** `<id>/plugin.json` — what `tools/plugin.mjs pack --zip` writes (server/plugins/pack.js, `zipPlugin`). */
function wrappedPluginZip(id, manifestExtra = {}) {
  const manifest = {
    manifest: 2, id, name: { zh: '测试', en: 'Test' }, version: '1.0.0', app: '*', api: 1,
    class: 'cosmetic', scope: ['room', 'personal'], permissions: ['assets.override'], assets: {},
    ...manifestExtra,
  };
  return zipFiles([{ name: `${id}/plugin.json`, data: Buffer.from(JSON.stringify(manifest)) }]);
}

test('importArchive: a plugin zip is staged by installPluginBytes; a dry run writes nothing', async () => {
  const dir = tmp();
  try {
    const zip = pluginZip('plugin-import-a');
    const dry = await importArchive(zip, { ...opts(dir), dryRun: true });
    assert.equal(dry.kind, 'plugin');
    assert.equal(dry.ok, true);
    assert.equal(dry.wrote, false);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(installed(dir), [], 'a dry run left the plugins folder empty');
    assert.equal(dry.compat?.kind, 'plugin', 'the dry run still reports a compatibility verdict');

    const real = await importArchive(zip, opts(dir));
    assert.equal(real.ok, true, JSON.stringify(real));
    assert.equal(real.wrote, true);
    assert.equal(real.id, 'plugin-import-a');
    assert.deepEqual(installed(dir), ['plugin-import-a']);
    assert.ok(fs.existsSync(path.join(dir, 'plugin-import-a', 'plugin.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importArchive: a second install without force is EXISTS; force replaces it', async () => {
  const dir = tmp();
  try {
    const zip = pluginZip('plugin-import-b');
    assert.equal((await importArchive(zip, opts(dir))).ok, true);
    const again = await importArchive(zip, opts(dir));
    assert.equal(again.ok, false);
    assert.equal(again.error, 'PLUGIN_INSTALL_EXISTS');
    assert.equal(again.wrote, false);

    const forced = await importArchive(zip, { ...opts(dir), force: true });
    assert.equal(forced.ok, true, JSON.stringify(forced));
    assert.equal(forced.wrote, true);
    assert.equal(forced.replaced !== null, true, 'the previous folder was moved aside, not lost');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importArchive: a package that is a valid zip but a bad manifest is CHECK, not a written folder', async () => {
  const dir = tmp();
  try {
    const bad = pluginZip('plugin-import-c', { class: 'no-such-class' });
    const r = await importArchive(bad, opts(dir));
    assert.equal(r.kind, 'plugin');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PLUGIN_INSTALL_CHECK');
    assert.deepEqual(installed(dir), [], 'a refused package leaves no folder behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importArchive: an out-of-range app is reported incompatible and still installs', async () => {
  const dir = tmp();
  try {
    const old = pluginZip('plugin-import-d', { app: '>=0.1.0 <0.2.0' });
    const r = await importArchive(old, opts(dir));
    assert.equal(r.compat?.status, 'incompatible', 'the verdict names the mismatch');
    assert.equal(r.ok, true, 'the verdict does not block the install');
    assert.deepEqual(installed(dir), ['plugin-import-d']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importArchive: an api outside the supported range is incompatible and refused at the manifest check', async () => {
  const dir = tmp();
  try {
    // The verdict says why; installPluginBytes refuses it on its own manifest check before any folder appears.
    const r = await importArchive(pluginZip('plugin-import-e', { api: 99 }), opts(dir));
    assert.equal(r.compat?.status, 'incompatible');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'PLUGIN_INSTALL_CHECK');
    assert.deepEqual(installed(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('importArchive: a zip wrapped in its id folder is still a plugin, and its verdict still reads', async () => {
  const dir = tmp();
  try {
    // The stripWrapper rule `readUntrustedZip` applies only knows pack.json; a wrapped plugin zip used to
    // come back `unknown` here while installPluginBytes accepted it.
    const zip = wrappedPluginZip('plugin-import-wrapped', { app: '>=0.1.0 <0.2.0' });
    assert.equal((await sniffArchive(zip)).kind, 'plugin');

    const r = await importArchive(zip, opts(dir));
    assert.equal(r.kind, 'plugin');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.compat?.status, 'incompatible', 'the wrapped manifest was read for the verdict');
    assert.ok(fs.existsSync(path.join(dir, 'plugin-import-wrapped', 'plugin.json')));

    const dry = await importArchive(wrappedPluginZip('plugin-import-wrapped2'), { ...opts(dir), dryRun: true });
    assert.equal(dry.kind, 'plugin');
    assert.equal(dry.wrote, false);
    assert.equal(dry.compat?.kind, 'plugin', 'a dry run of a wrapped zip still reports a verdict');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
