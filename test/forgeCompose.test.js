// test/forgeCompose.test.js — 把 Forge 工坊包合成成 0.3.0 的 `Plugin` 记录（server/forge/compose.js）。
//
// 这一层是整条移植路线的地基：包一旦进得了 `plugins[]`，房间选包 / 逐人同意 / `cs` 校验就全都
// 复用 0.3.0 既有机制，不需要第二条装载链。所以每条映射规则都在这里钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readForgePack, packToPlugin, scanForgePacks, serverPayloads } from '../server/forge/compose.js';

function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `sp-fcompose-${tag}-`)); }
function writePack(dir, manifest, files = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof body === 'string' ? body : JSON.stringify(body));
  }
}
const cleanup = (...dirs) => { for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } } };

test('纯数据包 ⇒ class content + parts.data.files（表名补 .json）', () => {
  const root = tmp('content');
  const dir = path.join(root, 'data-demo');
  try {
    writePack(dir, { id: 'data-demo', name: 'D', version: '1.0.0', content: ['chess', 'items'] },
      { 'chess.json': { chess_demo_a: { id: 'chess_demo_a' } }, 'items.json': {} });
    const pack = readForgePack(dir);
    assert.deepEqual(pack.errors, []);
    const p = packToPlugin(pack);
    assert.equal(p.class, 'content');
    assert.deepEqual(p.manifest.parts.data.files, ['chess.json', 'items.json']);
    assert.ok(p.manifest.permissions.includes('data.add'));
    assert.equal(p.status, 'loaded');
    assert.equal(p.source, 'workshop');
    assert.equal(p.layout, 'folder');
    assert.equal(p.supported, false, '工坊包不是语言包，不该污染 /packs/index.json');
    assert.equal(p.count, pack.files.length);
    assert.equal(p.hash, pack.hash);
  } finally { cleanup(root); }
});

test('带 client.panels ⇒ class ui；带服务端载荷 ⇒ class trusted 且优先级最高', () => {
  const root = tmp('class');
  try {
    const ui = path.join(root, 'ui-demo');
    writePack(ui, { id: 'ui-demo', version: '1.0.0', content: ['chess'], client: { panels: [{ id: 'p', slot: 'root.overlays', module: 'panel/p.js' }] } },
      { 'chess.json': {}, 'panel/p.js': 'export const x=1;' });
    const pu = packToPlugin(readForgePack(ui));
    assert.equal(pu.class, 'ui');

    const srv = path.join(root, 'srv-demo');
    writePack(srv, {
      id: 'srv-demo', version: '1.0.0', content: ['chess'], combat: true,
      server: { modules: [{ id: 'm', entry: 'server/m.mjs', uses: ['boot'] }] },
    }, { 'chess.json': {}, 'server/m.mjs': 'export function registerServer(){}' });
    const ps = packToPlugin(readForgePack(srv));
    assert.equal(ps.class, 'trusted', '有服务端代码 ⇒ trusted（这条决定它走 0.3.0 的同意闸门）');
    assert.ok(ps.manifest.permissions.includes('trusted.server'));
    assert.deepEqual(ps.manifest.forge.payloads, ['modules']);
    assert.equal(ps.manifest.forge.combat, true);
  } finally { cleanup(root); }
});

test('只有素材、没有内容表 ⇒ class cosmetic；有内容表则留在 content', () => {
  const root = tmp('cosmetic');
  try {
    const c = path.join(root, 'art-demo');
    // assets 容器必须是包内相对的 .spresources 文件（形状层判据），否则 ASSETS_BAD_CONTAINER
    // Forge 的 assets 必须成对声明 container + manifest（形状层判据）
    writePack(c, { id: 'art-demo', version: '1.0.0', license: 'CC0-1.0', assets: { container: 'c.spresources', manifest: 'c.json' } }, { 'c.spresources': 'x', 'c.json': JSON.stringify({ files: {} }) });
    const pc = packToPlugin(readForgePack(c));
    assert.equal(pc.class, 'cosmetic');
    assert.ok(pc.manifest.permissions.includes('assets.add'));

    const both = path.join(root, 'both-demo');
    writePack(both, { id: 'both-demo', version: '1.0.0', license: 'CC0-1.0', content: ['chess'], assets: { container: 'c.spresources', manifest: 'c.json' } },
      { 'chess.json': {}, 'c.spresources': 'x', 'c.json': JSON.stringify({ files: {} }) });
    const pb = packToPlugin(readForgePack(both));
    assert.equal(pb.class, 'content', '有内容表就以 content 为主（素材只是它的附加面）');
    assert.ok(pb.manifest.parts.data);
    assert.ok(pb.manifest.parts.assets);
  } finally { cleanup(root); }
});

test('serverPayloads 只认四个执行面，routes 不算', () => {
  assert.deepEqual(serverPayloads({ server: { modules: [1] } }), ['modules']);
  assert.deepEqual(serverPayloads({ server: { battle: {} } }), ['battle']);
  assert.deepEqual(serverPayloads({ server: { meta: [1] } }), ['meta']);
  assert.deepEqual(serverPayloads({ server: { room: {} } }), ['room']);
  assert.deepEqual(serverPayloads({ server: { routes: [1] } }), [], '只读端点不是"跑代码"');
  assert.deepEqual(serverPayloads({}), []);
  assert.deepEqual(serverPayloads(null), []);
});

test('坏包不抛、具名跳过（与 0.3.0 的 scanPlugins 同一纪律）', () => {
  const root = tmp('bad');
  try {
    writePack(path.join(root, 'broken'), { id: 'broken', version: '1.0.0', bogus: 1 });
    const good = path.join(root, 'good');
    writePack(good, { id: 'good', version: '1.0.0', content: ['chess'] }, { 'chess.json': {} });
    const { plugins, skipped } = scanForgePacks(root);
    assert.equal(plugins.length, 1, '好包照旧出来');
    assert.equal(plugins[0].id, 'good');
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].problems[0], /PACK_UNKNOWN_FIELD|bogus/i);
  } finally { cleanup(root); }
});

test('身份稳定：同内容同 hash，改一个字节就变', () => {
  const root = tmp('hash');
  try {
    const a = path.join(root, 'same');
    writePack(a, { id: 'same', version: '1.0.0', content: ['chess'] }, { 'chess.json': { x: 1 } });
    const h1 = readForgePack(a).hash;
    const h2 = readForgePack(a).hash;
    assert.equal(h1, h2, '同样的字节 ⇒ 同一个 hash');
    fs.writeFileSync(path.join(a, 'README.md'), 'changed');
    const h3 = readForgePack(a).hash;
    assert.notEqual(h1, h3, '包目录里任何文件的字节变了，身份就变（与 Forge 侧同一口径）');
  } finally { cleanup(root); }
});

test('工坊根不存在 ⇒ 零包零错（与「没有 plugins/」同一条纪律）', () => {
  const { plugins, skipped } = scanForgePacks(path.join(os.tmpdir(), 'sp-absolutely-not-here-xyz'));
  assert.deepEqual(plugins, []);
  assert.deepEqual(skipped, []);
});
