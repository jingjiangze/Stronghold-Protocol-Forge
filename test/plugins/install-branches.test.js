// test/plugins/install-branches.test.js — the installPluginBytes refusals that had no test.
//
// FORGE-COMPAT.md §5 named two of them (SIZE and CHECK) and the audit found two more that no caller ever
// reaches in the suite: a mismatched `expectedId`, and a `plugins/_incoming` that is not a real folder.
// They are one line each in install.js and were entirely unprotected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installPluginBytes } from '../../server/plugins/install.js';
import { zipFiles } from '../../server/plugins/zip.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-install-branch-'));
const installed = (dir) => fs.readdirSync(dir).filter((n) => !/^[._]/.test(n)).sort();

function pluginZip(id, manifestExtra = {}) {
  const manifest = {
    manifest: 2, id, name: { zh: '测试', en: 'Test' }, version: '1.0.0', app: '*', api: 1,
    class: 'cosmetic', scope: ['room', 'personal'], permissions: ['assets.override'], assets: {},
    ...manifestExtra,
  };
  return zipFiles([{ name: 'plugin.json', data: Buffer.from(JSON.stringify(manifest)) }]);
}

test('installPluginBytes: the raw size limit is its own refusal', async () => {
  const dir = tmp();
  try {
    const zip = pluginZip('size-branch');
    await assert.rejects(
      async () => installPluginBytes(zip, { pluginsDir: dir, maxBytes: 8 }),
      (e) => e.code === 'PLUGIN_INSTALL_SIZE' && /270 bytes is over the limit|over the limit/.test(e.message),
    );
    assert.deepEqual(installed(dir), [], 'nothing was staged');
    // The same bytes go in once the limit is the real one.
    const ok = installPluginBytes(zip, { pluginsDir: dir });
    assert.equal(ok.id, 'size-branch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installPluginBytes: expectedId refuses a zip that carries another plugin', async () => {
  const dir = tmp();
  try {
    const zip = pluginZip('expected-real');
    await assert.rejects(
      async () => installPluginBytes(zip, { pluginsDir: dir, expectedId: 'expected-other' }),
      (e) => e.code === 'PLUGIN_INSTALL_ZIP' && /the zip is expected-real, not expected-other/.test(e.message),
    );
    assert.deepEqual(installed(dir), []);
    const ok = installPluginBytes(zip, { pluginsDir: dir, expectedId: 'expected-real' });
    assert.equal(ok.id, 'expected-real');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installPluginBytes: a manifest that fails the folder check is CHECK, with the problem as the message', async () => {
  const dir = tmp();
  try {
    await assert.rejects(
      async () => installPluginBytes(pluginZip('check-branch', { class: 'no-such-class' }), { pluginsDir: dir }),
      (e) => e.code === 'PLUGIN_INSTALL_CHECK' && typeof e.message === 'string' && e.message.length > 0,
    );
    assert.deepEqual(installed(dir), [], 'a refused package leaves no folder behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installPluginBytes: no plugins directory is refused before anything is read', async () => {
  await assert.rejects(
    async () => installPluginBytes(pluginZip('no-dir'), {}),
    (e) => e.code === 'PLUGIN_INSTALL_ZIP' && /no plugins directory/.test(e.message),
  );
});

test('installPluginBytes: a plugins/_incoming that is a symbolic link is refused', async (t) => {
  const dir = tmp();
  const target = tmp();
  try {
    try { fs.symlinkSync(target, path.join(dir, '_incoming'), 'dir'); } catch {
      t.skip('this account cannot create symbolic links');
      return;
    }
    await assert.rejects(
      async () => installPluginBytes(pluginZip('incoming-link'), { pluginsDir: dir }),
      (e) => e.code === 'PLUGIN_INSTALL_ZIP' && /_incoming is not a real folder/.test(e.message),
    );
    assert.deepEqual(installed(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
