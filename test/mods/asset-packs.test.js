// test/mods/asset-packs.test.js — the mod manager's asset layers: the skin manifest rewrite and the official
// effects file list (server/mods/assetPacks.js). Pure plans first, then one round trip through a temp data/ dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  skinEntry, planSkins, applySkinWrites, clearSkinWrites, skinsStatus, isAssetPath,
  readFxManifest, fxSamplePaths, verifyFxManifest, syncSkins, clearSkins, installFx, verifyFx,
} from '../../server/mods/assetPacks.js';
import { mergeLocalChars } from '../../server/plugins/artReferences.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sp-assets-'));

const spine = (root) => ({
  front: { skel: `${root}/front/x.skel`, atlas: `${root}/front/x.atlas`, textures: [`${root}/front/x.png`], pma: false, anims: { idle: 'Idle' } },
  back: { skel: `${root}/back/x.skel`, atlas: `${root}/back/x.atlas`, textures: [`${root}/back/x.png`], pma: false, anims: { idle: 'Idle' } },
});

const sourceAssets = () => ({
  chars: {
    char_102_texas: {
      avatar: '/assets/char/avatar/char_102_texas.png',
      portrait: '/assets/char/portrait/char_102_texas.png',
      spine: { front: { skel: '/assets/spine/op/char_102_texas/front/x.skel', atlas: '/assets/spine/op/char_102_texas/front/x.atlas' } },
    },
  },
  skins: {
    char_102_texas_epoque_7: {
      charId: 'char_102_texas',
      name: '意志',
      brand: '时代',
      avatar: '/assets/skins/char_102_texas_epoque_7/avatar.png',
      portrait: '/assets/skins/char_102_texas_epoque_7/portrait.png',
      illustration: '/assets/skins/char_102_texas_epoque_7/illustration.png',
      spine: spine('/assets/skins/char_102_texas_epoque_7'),
      dynamicDeclared: true,
    },
  },
});

const fxDoc = () => ({
  version: 1,
  source: 'test',
  groups: {
    fx: { index: { path: '/assets/local/fx/index.json' }, textures: { path: '/assets/local/fx/textures.json' } },
    'fx/prefabs': { accast_attack_01_hit: { path: '/assets/local/fx/prefabs/accast_attack_01_hit.json', size: 10 } },
    'fx/tex': { '1013_chen2_18-ef0bbae2': { path: '/assets/local/fx/tex/1013_chen2_18-ef0bbae2.webp', w: 64, h: 64 } },
    'fx/mesh': { '001-277b8cad': { path: '/assets/local/fx/mesh/001-277b8cad.json', size: 20 } },
  },
});

test('asset path: root-relative /assets only, no traversal', () => {
  assert.equal(isAssetPath('/assets/skins/a/b.png'), true);
  assert.equal(isAssetPath('https://cdn.example/a.png'), false);
  assert.equal(isAssetPath('/assets/../secret'), false);
  assert.equal(isAssetPath('/assets/a b.png'), true);
  assert.equal(isAssetPath('/fonts/a.png'), false);
});

test('skinEntry: brand → group, illustration → illust, spine kept, unknown fields dropped', () => {
  const made = skinEntry(sourceAssets().skins.char_102_texas_epoque_7);
  assert.equal(made.charId, 'char_102_texas');
  assert.deepEqual(made.entry, {
    name: '意志',
    group: '时代',
    avatar: '/assets/skins/char_102_texas_epoque_7/avatar.png',
    portrait: '/assets/skins/char_102_texas_epoque_7/portrait.png',
    illust: '/assets/skins/char_102_texas_epoque_7/illustration.png',
    spine: spine('/assets/skins/char_102_texas_epoque_7'),
  });
  assert.equal('dynamicDeclared' in made.entry, false);
});

test('planSkins: missing writes, identical is same, different is a conflict, bad record is skipped', () => {
  const assets = sourceAssets();
  const first = planSkins({ assets, local: { chars: {} } });
  assert.equal(first.sourceCount, 1);
  assert.equal(first.writes.length, 1);
  assert.equal(first.conflicts.length, 0);

  const written = applySkinWrites({ chars: {} }, first.writes);
  const second = planSkins({ assets, local: written });
  assert.equal(second.writes.length, 0);
  assert.equal(second.same.length, 1);

  const drifted = structuredClone(written);
  drifted.chars.char_102_texas.skins.char_102_texas_epoque_7.name = '别的名字';
  const third = planSkins({ assets, local: drifted });
  assert.equal(third.conflicts.length, 1);
  assert.equal(third.writes.length, 0);

  const bad = planSkins({ assets: { skins: { nope: { charId: 'not-a-char', name: 'x' } } }, local: {} });
  assert.equal(bad.skipped.length, 1);
  assert.equal(bad.writes.length, 0);
});

test('applySkinWrites keeps groups and the operator art; mergeLocalChars serves the skins', () => {
  const assets = sourceAssets();
  const local = { version: 1, source: 'local-client', count: 1, groups: { 'ui/x': { path: '/assets/local/ui/x.png' } }, chars: {} };
  const plan = planSkins({ assets, local });
  const next = applySkinWrites(local, plan.writes);
  assert.deepEqual(Object.keys(next.groups), ['ui/x']);
  assert.equal(next.chars.char_102_texas.avatar, undefined);

  const merged = mergeLocalChars(assets, next);
  assert.equal(merged.chars.char_102_texas.avatar, '/assets/char/avatar/char_102_texas.png');
  assert.equal(merged.chars.char_102_texas.skins.char_102_texas_epoque_7.illust, '/assets/skins/char_102_texas_epoque_7/illustration.png');
  assert.equal(merged.chars.char_102_texas.skins.char_102_texas_epoque_7.group, '时代');
});

test('clearSkinWrites removes only the ids it is given', () => {
  const local = {
    chars: {
      char_102_texas: { skins: { a: { name: 'a' }, b: { name: 'b' } } },
      char_003_kalts: { skins: { c: { name: 'c' } } },
    },
  };
  const next = clearSkinWrites(local, ['a', 'c']);
  assert.deepEqual(Object.keys(next.chars.char_102_texas.skins), ['b']);
  assert.equal(next.chars.char_003_kalts, undefined);
});

test('skinsStatus counts present, missing and extra', () => {
  const assets = sourceAssets();
  const local = applySkinWrites({ chars: {} }, planSkins({ assets, local: {} }).writes);
  local.chars.char_102_texas.skins.extra_one = { name: 'x' };
  const s = skinsStatus({ assets, local });
  assert.equal(s.sourceCount, 1);
  assert.equal(s.present, 1);
  assert.equal(s.missing, 0);
  assert.equal(s.extra, 1);
  assert.equal(s.chars, 1);
});

test('readFxManifest: counts, empty prefabs and upper-case keys are reported', () => {
  const ok = readFxManifest(fxDoc());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.counts, { fx: 2, 'fx/prefabs': 1, 'fx/tex': 1, 'fx/mesh': 1 });

  const empty = fxDoc();
  empty.groups['fx/prefabs'] = {};
  assert.equal(readFxManifest(empty).ok, false);

  const upper = fxDoc();
  upper.groups['fx/prefabs'].UPPER = upper.groups['fx/prefabs'].accast_attack_01_hit;
  const r = readFxManifest(upper);
  assert.equal(r.ok, true);
  assert.equal(r.problems.some((p) => p.includes('lower case')), true);
});

test('fxSamplePaths: unique, limited, includes both shared indexes', () => {
  const rows = fxSamplePaths(fxDoc(), 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.key), ['index', 'textures']);
  assert.equal(new Set(rows.map((r) => r.path)).size, rows.length);
});

test('verifyFxManifest: HEAD, and a one-byte GET when HEAD is refused', async () => {
  let calls = 0;
  const fake = async (_url, opts) => {
    calls++;
    if (opts?.method === 'HEAD') return new Response(null, { status: 405 });
    return new Response('x', { status: 206, headers: { 'content-length': '1' } });
  };
  const r = await verifyFxManifest({ doc: fxDoc(), samples: 2, fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(r.rows.length, 2);
  assert.equal(calls, 4);
  assert.equal(r.rows.every((x) => x.status === 206 && x.bytes === 1), true);
});

test('syncSkins / clearSkins round trip through a data directory', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify(sourceAssets()));
  fs.writeFileSync(path.join(dir, 'local-assets.json'), JSON.stringify({ version: 1, source: 'local-client', groups: {} }));

  const first = await syncSkins({ dataDir: dir });
  assert.equal(first.ok, true);
  assert.equal(first.added, 1);
  assert.equal(first.wrote, 1);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'local-assets.json'), 'utf8'));
  assert.equal(written.chars.char_102_texas.skins.char_102_texas_epoque_7.name, '意志');

  const second = await syncSkins({ dataDir: dir });
  assert.equal(second.wrote, 0);
  assert.equal(second.unchanged, 1);

  const dry = await clearSkins({ dataDir: dir, dryRun: true });
  assert.equal(dry.removed, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'local-assets.json'), 'utf8')).chars.char_102_texas.skins.char_102_texas_epoque_7.name, '意志');

  const cleared = await clearSkins({ dataDir: dir });
  assert.equal(cleared.removed, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'local-assets.json'), 'utf8')).chars, {});
});

test('installFx writes the manifest, records the ledger and verifies samples', async () => {
  const dir = tmp();
  const body = JSON.stringify(fxDoc());
  const fake = async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const r = await installFx({ dataDir: dir, url: 'https://example.test/local-fx.json', fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(r.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'local-fx.json'), 'utf8')).groups['fx/prefabs'].accast_attack_01_hit.size, 10);
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'mod-assets.json'), 'utf8'));
  assert.equal(ledger.fx.url, 'https://example.test/local-fx.json');
  assert.equal(ledger.fx.sha256.length, 64);

  const v = await verifyFx({ dataDir: dir, samples: 1, fetchImpl: fake });
  assert.equal(v.ok, true);
  assert.equal(v.rows.length, 1);
});

test('installFx refuses a manifest with no prefabs', async () => {
  const dir = tmp();
  const bad = fxDoc();
  bad.groups['fx/prefabs'] = {};
  const fake = async () => new Response(JSON.stringify(bad), { status: 200 });
  const r = await installFx({ dataDir: dir, fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'FX_MANIFEST');
  assert.equal(fs.existsSync(path.join(dir, 'local-fx.json')), false);
});
