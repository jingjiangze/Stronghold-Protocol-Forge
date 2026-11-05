// test/mods/ — the mod manager: one archive in, one answer out, and the drop-in inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importArchive, sniffArchive } from '../../server/mods/import.js';
import { startInbox } from '../../server/mods/inbox.js';
import { createMods } from '../../server/mods/index.js';
import { modPage } from '../../server/mods/page.js';
import { readVanillaAssets } from '../../server/plugins/registry.js';
import { zipFiles } from '../../server/plugins/zip.js';
import { main } from '../../tools/mod.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'forge', 'numbers-pack');
const vanilla = readVanillaAssets(path.join(ROOT, 'data'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-mods-'));

function zipDir(dir) {
  const files = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      const p = path.join(abs, name);
      const next = rel ? `${rel}/${name}` : name;
      if (fs.statSync(p).isDirectory()) walk(p, next);
      else files.push({ name: next, data: fs.readFileSync(p) });
    }
  };
  walk(dir, '');
  return zipFiles(files);
}

const opts = (pluginsDir) => ({ root: ROOT, pluginsDir, dataDir: path.join(ROOT, 'data'), vanilla });

test('sniff: pack.json is a Forge pack, plugin.json a plugin, neither is refused', async () => {
  assert.equal((await sniffArchive(zipFiles([{ name: 'pack.json', data: Buffer.from('{}') }]))).kind, 'pack');
  assert.equal((await sniffArchive(zipFiles([{ name: 'plugin.json', data: Buffer.from('{}') }]))).kind, 'plugin');
  const r = await importArchive(zipFiles([{ name: 'readme.md', data: Buffer.from('x') }]), opts(tmp()));
  assert.equal(r.ok, false);
  assert.equal(r.error, 'PLUGIN_INSTALL_ZIP');
});

test('import: a Forge pack becomes plugin folders through forgeImport; a dry run writes nothing', async () => {
  const dir = tmp();
  const zip = zipDir(FIXTURE);
  const dry = await importArchive(zip, { ...opts(dir), dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.wrote, false);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => !n.startsWith('.')), [], 'dry run left the plugins folder empty');

  const real = await importArchive(zip, opts(dir));
  assert.equal(real.ok, true, JSON.stringify(real.issues));
  assert.equal(real.wrote, true);
  const built = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  assert.ok(built.length >= 1, 'at least one plugin folder was written');
  for (const id of built) {
    assert.ok(fs.existsSync(path.join(dir, id, 'plugin.json')), `${id}/plugin.json`);
  }
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('.forge-import-')), [], 'no staging folder is left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inbox: a dropped zip is imported once its size settles, then moved to _done', async () => {
  const dir = tmp();
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const seen = [];
  const w = startInbox({ dir: inbox, importFile: async (file) => { seen.push(path.basename(file)); return { ok: true, kind: 'pack', wrote: true }; } });
  try {
    fs.writeFileSync(path.join(inbox, 'a.zip'), zipDir(FIXTURE));
    // three drains: the first records the size, the next two confirm it stopped changing
    for (let i = 0; i < 4; i++) await w.drain();
    assert.deepEqual(seen, ['a.zip']);
    assert.deepEqual(fs.readdirSync(inbox).filter((n) => n.endsWith('.zip')), [], 'the zip left the inbox');
    assert.equal(fs.readdirSync(path.join(inbox, '_done')).filter((n) => n.endsWith('a.zip')).length, 1);
  } finally { w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('inbox: a refused zip goes to _failed with a reason file', async () => {
  const dir = tmp();
  const inbox = path.join(dir, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  const w = startInbox({ dir: inbox, importFile: async () => ({ ok: false, error: 'PLUGIN_INSTALL_ZIP', detail: 'nothing inside' }) });
  try {
    fs.writeFileSync(path.join(inbox, 'b.zip'), Buffer.from('not a zip'));
    for (let i = 0; i < 4; i++) await w.drain();
    const failed = fs.readdirSync(path.join(inbox, '_failed'));
    assert.equal(failed.filter((n) => n.endsWith('b.zip')).length, 1);
    const reason = fs.readFileSync(path.join(inbox, '_failed', failed.find((n) => n.endsWith('.reason.txt'))), 'utf8');
    assert.match(reason, /PLUGIN_INSTALL_ZIP/);
  } finally { w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('cli pack: a folder becomes a deterministic zip that sniff reads as a pack', async () => {
  const dir = tmp();
  const out = path.join(dir, 'packed.zip');
  const code = await main(['pack', FIXTURE, '-o', out]);
  assert.equal(code, 0);
  const a = fs.readFileSync(out);
  const code2 = await main(['pack', FIXTURE, '-o', path.join(dir, 'again.zip')]);
  assert.equal(code2, 0);
  assert.deepEqual(a, fs.readFileSync(path.join(dir, 'again.zip')), 'two packs of the same folder are byte-identical');
  assert.equal((await sniffArchive(a)).kind, 'pack');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the /mod host owns exactly its own paths and serves a self-contained page', () => {
  const dir = tmp();
  const mods = createMods({ root: ROOT, pluginsDir: dir, dataDir: path.join(ROOT, 'data'), autoInbox: false });
  try {
    assert.equal(mods.handles('/mod'), true);
    assert.equal(mods.handles('/mod/'), true);
    assert.equal(mods.handles('/mod/status.json'), true);
    assert.equal(mods.handles('/mods'), false);
    assert.equal(mods.handles('/modx'), false);
    const page = modPage({ inbox: mods.inboxDir, keyHint: path.join(dir, '.studio-key') });
    assert.match(page, /^<!doctype html>/);
    assert.match(page, /\/mod\/upload/);
    assert.match(page, /\/mod\/fetch/);
    assert.doesNotMatch(page, /<script[^>]+src=/, 'no external script');
    assert.doesNotMatch(page, /<link[^>]+href=/, 'no external stylesheet');
  } finally { mods.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
