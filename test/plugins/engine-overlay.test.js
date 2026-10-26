// test/plugins/engine-overlay.test.js — an engine-level plugin starts the server from `.shadow/`.
//
// The overlay is the one place a plugin may replace files of the engine itself, so the rules worth pinning are:
// only `trusted`, only an explicit list, only under server/shared/public, only when the owner names it, and the
// whole thing turns off (`SP_OVERLAY=off`) without leaving a half-built root behind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OVERLAY_ACTIVE, OVERLAY_DIR, OVERLAY_STAMP, buildShadow, overlayHash, resolveEngineOverlay, safeRel, shadowArgv,
  shadowCurrent, shadowEntry, shadowNodeOptions,
} from '../../server/plugins/engineOverlay.js';

const tmp = (name = 'sp-overlay-') => fs.mkdtempSync(path.join(os.tmpdir(), name));
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** A tiny install root: server/index.js, server/keep.js, shared/a.js, public/x.css, plugins/<id>/. */
function install({ id = 'hexmod', manifest, engine = {}, config = {} } = {}) {
  const root = tmp();
  put(path.join(root, 'server', 'index.js'), '// engine entry\n');
  put(path.join(root, 'server', 'keep.js'), '// untouched\n');
  put(path.join(root, 'shared', 'a.js'), '// engine shared\n');
  put(path.join(root, 'public', 'x.css'), '/* engine */\n');
  put(path.join(root, 'public', 'css', 'theme.css'), '/* theme */\n');
  const pluginsDir = path.join(root, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify(manifest ?? {
    manifest: 2, id, name: { zh: '测试', en: 'Test' }, version: '1.0.0', app: '*', api: 1,
    class: 'trusted', permissions: ['trusted.server'], entry: { server: 'host/noop.js' },
    code: { engine: ['server/index.js', 'shared/new.js'] },
  })}\n`);
  for (const [rel, body] of Object.entries(engine)) put(path.join(dir, 'engine', ...rel.split('/')), body);
  return { root, pluginsDir, dir };
}

test('safeRel: only server/ shared/ public/, never absolute or ..', () => {
  assert.equal(safeRel('server/lobby.js'), 'server/lobby.js');
  assert.equal(safeRel('shared\\a.js'), 'shared/a.js');
  for (const bad of ['/etc/passwd', 'C:/x', '../server/a.js', 'server/../a.js', 'data/a.json', 'plugins/a.js', '', 'server//a.js']) {
    assert.equal(safeRel(bad), null, String(bad));
  }
});

test('resolveEngineOverlay: nothing named means nothing happens', () => {
  const { root, pluginsDir } = install({ config: {} });
  assert.equal(resolveEngineOverlay({ root, pluginsDir }), null);
});

test('resolveEngineOverlay: refuses an untrusted plugin, a missing engine file and a path outside the allowed folders', () => {
  {
    const { root, pluginsDir } = install({ config: { overlay: 'hexmod' }, manifest: {
      manifest: 2, id: 'hexmod', version: '1.0.0', app: '*', api: 1, class: 'content',
      permissions: [], code: { engine: ['server/index.js'] },
    } });
    assert.match(resolveEngineOverlay({ root, pluginsDir }).why, /not a trusted one/);
  }
  {
    const { root, pluginsDir } = install({ config: { overlay: 'hexmod' } });
    assert.match(resolveEngineOverlay({ root, pluginsDir }).why, /does not exist/);
  }
  {
    const { root, pluginsDir } = install({ config: { overlay: 'hexmod' }, manifest: {
      manifest: 2, id: 'hexmod', version: '1.0.0', app: '*', api: 1, class: 'trusted',
      permissions: ['trusted.server'], code: { engine: ['data/config.json'] },
    } });
    assert.match(resolveEngineOverlay({ root, pluginsDir }).why, /only paths under/);
  }
});

test('buildShadow: the replaced file wins, the rest of the engine is still there, and the stamp makes it idempotent', () => {
  const { root, pluginsDir } = install({
    config: { overlay: 'hexmod' },
    manifest: {
      manifest: 2, id: 'hexmod', version: '1.0.0', app: '*', api: 1, class: 'trusted',
      permissions: ['trusted.server'], entry: { server: 'host/noop.js' },
      code: { engine: ['server/index.js', 'shared/new.js', 'public/css/screens/deep.css'] },
    },
    engine: {
      'server/index.js': '// patched entry\n',
      'shared/new.js': 'export const x = 1;\n',
      'public/css/screens/deep.css': '/* deep */\n',
    },
  });
  const overlay = resolveEngineOverlay({ root, pluginsDir });
  assert.equal(overlay.why, undefined);
  assert.deepEqual(overlay.files.sort(), ['public/css/screens/deep.css', 'server/index.js', 'shared/new.js']);

  const built = buildShadow({ root, overlay });
  assert.equal(built.built, true);
  const shadow = path.join(root, OVERLAY_DIR);
  assert.equal(fs.readFileSync(path.join(shadow, 'server', 'index.js'), 'utf8'), '// patched entry\n');
  assert.equal(fs.readFileSync(path.join(shadow, 'shared', 'new.js'), 'utf8'), 'export const x = 1;\n');
  assert.equal(fs.readFileSync(path.join(shadow, 'server', 'keep.js'), 'utf8'), '// untouched\n');
  assert.equal(fs.readFileSync(path.join(shadow, 'shared', 'a.js'), 'utf8'), '// engine shared\n');
  assert.equal(fs.readFileSync(path.join(shadow, 'public', 'css', 'screens', 'deep.css'), 'utf8'), '/* deep */\n',
    'a file nested under a linked folder replaces just that file');
  assert.equal(fs.readFileSync(path.join(shadow, 'public', 'css', 'theme.css'), 'utf8'), '/* theme */\n',
    "its siblings are still the engine's");
  assert.ok(fs.existsSync(path.join(shadow, OVERLAY_STAMP)));

  assert.equal(shadowCurrent({ root, overlay }), true);
  assert.equal(buildShadow({ root, overlay }).built, false, 'an unchanged input is not rebuilt');

  // Editing the plugin's copy invalidates the stamp; the next build picks it up.
  fs.writeFileSync(path.join(overlay.dir, 'server', 'index.js'), '// patched twice\n');
  assert.equal(shadowCurrent({ root, overlay }), false);
  buildShadow({ root, overlay });
  assert.equal(fs.readFileSync(path.join(shadow, 'server', 'index.js'), 'utf8'), '// patched twice\n');
  assert.equal(overlayHash({ root, overlay }).length, 64);
});

test('shadowEntry: off, already inside, and the normal case', () => {
  const { root, pluginsDir } = install({
    config: { overlay: 'hexmod' },
    engine: { 'server/index.js': '// patched\n', 'shared/new.js': 'export const x = 1;\n' },
  });
  const off = shadowEntry({ root, pluginsDir, env: { SP_OVERLAY: 'off' } });
  assert.equal(off, null, 'SP_OVERLAY=off disables the whole thing');

  const inside = shadowEntry({ root, pluginsDir, env: { [OVERLAY_ACTIVE]: '1' } });
  assert.equal(inside, null, 'the child never spawns itself');

  const hit = shadowEntry({ root, pluginsDir, env: {} });
  assert.ok(hit, 'a named overlay yields an entry');
  assert.equal(path.relative(root, hit.entry).replace(/\\/g, '/'), `${OVERLAY_DIR}/server/index.js`);

  fs.rmSync(root, { recursive: true, force: true });
});

test('the shadow child runs with --preserve-symlinks, so ROOT stays inside .shadow', () => {
  // The shadow root IS symlinks. Without these flags Node realpath-uses the engine folder, and the
  // runtime (Match, views, lobby) silently runs the untouched engine — only static files come from the
  // overlay. The flags are also passed down via NODE_OPTIONS for the forked grandchildren (match hosts).
  assert.deepEqual(shadowArgv(), ['--preserve-symlinks', '--preserve-symlinks-main']);
  assert.equal(shadowNodeOptions({}), '--preserve-symlinks --preserve-symlinks-main');
  assert.equal(shadowNodeOptions({ NODE_OPTIONS: '--max-warnings=0' }), '--max-warnings=0 --preserve-symlinks --preserve-symlinks-main');
});
