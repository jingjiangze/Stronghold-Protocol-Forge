// test/forgeInbox.test.js — 拖目录即安装（0.3.0 线的投递层）。
//
// 钉住：① 好包装得上且落在 workshop/<id>/；② 坏归档/恶意归档**具名拒绝且不留半个包**；
// ③ 已存在不静默覆盖；④ 处理完的 zip 搬家而不是删除，失败留 .reason.txt。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { zipFiles } from '../server/plugins/zip.js';
import { installPackZip, drainInbox, pendingInbox, packPrefix } from '../server/forge/inbox.js';

const tmp = (t) => fs.mkdtempSync(path.join(os.tmpdir(), `sp-inbox-${t}-`));
const cleanup = (...d) => { for (const x of d) { try { fs.rmSync(x, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } } };

function packZip(id, { prefix = '', extra = {} } = {}) {
  const files = {
    'pack.json': JSON.stringify({ id, name: id, version: '1.0.0', content: ['chess'] }),
    'chess.json': JSON.stringify({ [`chess_${id.replace(/-/g, '_')}_a`]: { id: `chess_${id.replace(/-/g, '_')}_a` } }),
    ...extra,
  };
  const entries = Object.entries(files).map(([name, body]) => ({ name: `${prefix}${name}`, data: Buffer.from(body) }));
  return zipFiles(entries);
}

test('packPrefix：根 / 唯一顶层目录 / 多顶层目录被拒', () => {
  assert.equal(packPrefix(['pack.json', 'chess.json']), '');
  assert.equal(packPrefix(['a/pack.json', 'a/chess.json']), 'a/');
  assert.throws(() => packPrefix(['a/pack.json', 'b/pack.json']), /多个顶层目录/);
  assert.throws(() => packPrefix(['chess.json']), /没有 pack.json/);
});

test('好包：装进 workshop/<id>/，zip 里多余的顶层散文件不进包', () => {
  const root = tmp('ok');
  try {
    const r = installPackZip({ workshopRoot: root, buffer: packZip('demo-pack') });
    assert.equal(r.id, 'demo-pack');
    assert.ok(fs.existsSync(path.join(root, 'demo-pack', 'pack.json')));
    assert.ok(fs.existsSync(path.join(root, 'demo-pack', 'chess.json')));
    assert.equal(fs.readdirSync(root).some((n) => n.startsWith('.forge-import-')), false, '临时目录必须清干净');
  } finally { cleanup(root); }
});

test('套一层顶层目录的归档也认', () => {
  const root = tmp('nested');
  try {
    const r = installPackZip({ workshopRoot: root, buffer: packZip('nested-pack', { prefix: 'nested-pack/' }) });
    assert.equal(r.id, 'nested-pack');
    assert.ok(fs.existsSync(path.join(root, 'nested-pack', 'pack.json')));
  } finally { cleanup(root); }
});

test('坏归档：具名拒绝，且 workshop/ 里不留半个包', () => {
  const root = tmp('bad');
  try {
    assert.throws(() => installPackZip({ workshopRoot: root, buffer: Buffer.from('not a zip') }), /zip/i);
    // 没有 pack.json 的归档
    const noManifest = zipFiles([{ name: 'readme.txt', data: Buffer.from('x') }]);
    assert.throws(() => installPackZip({ workshopRoot: root, buffer: noManifest }), /pack\.json/);
    // 清单不合法（闭集外的键）
    const badManifest = zipFiles([
      { name: 'pack.json', data: Buffer.from(JSON.stringify({ id: 'x', version: '1.0.0', bogus: 1 })) },
      { name: 'chess.json', data: Buffer.from('{}') },
    ]);
    assert.throws(() => installPackZip({ workshopRoot: root, buffer: badManifest }), /PACK_UNKNOWN_FIELD|bogus|未知/i);
    assert.deepEqual(fs.readdirSync(root).filter((n) => !n.startsWith('.forge')), [], '一个包目录都不该留下');
  } finally { cleanup(root); }
});

test('恶意归档（../ 穿越）在读归档时就被拒', () => {
  const root = tmp('slip');
  try {
    const evil = zipFiles([{ name: '../escape.json', data: Buffer.from('x') }]);
    assert.throws(() => installPackZip({ workshopRoot: root, buffer: evil }), /zip|name|path/i);
  } finally { cleanup(root); }
});

test('已存在：不静默覆盖；显式 force 才替换', () => {
  const root = tmp('exists');
  try {
    installPackZip({ workshopRoot: root, buffer: packZip('dup-pack') });
    assert.throws(() => installPackZip({ workshopRoot: root, buffer: packZip('dup-pack') }), /已经存在/);
    const forced = installPackZip({ workshopRoot: root, buffer: packZip('dup-pack'), force: true });
    assert.equal(forced.id, 'dup-pack');
  } finally { cleanup(root); }
});

test('drainInbox：好包搬进 installed/，坏包搬进 failed/ 并留 .reason.txt', () => {
  const root = tmp('drain');
  try {
    fs.writeFileSync(path.join(root, 'a-good.zip'), packZip('good-pack'));
    fs.writeFileSync(path.join(root, 'b-bad.zip'), 'not a zip');
    assert.equal(pendingInbox(root).length, 2);
    const results = drainInbox(root);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.equal(fs.readdirSync(root).filter((n) => n.endsWith('.zip')).length, 0, '处理完的 zip 不该留在原处');
    const failedDir = path.join(root, '.forge-inbox', 'failed');
    const reason = fs.readdirSync(failedDir).find((n) => n.endsWith('.reason.txt'));
    assert.ok(reason, '失败原因落盘');
    assert.match(fs.readFileSync(path.join(failedDir, reason), 'utf8'), /zip/i);
  } finally { cleanup(root); }
});

test('pendingInbox 不把 installed/ 里的留底当成待安装（避免自装循环）', () => {
  const root = tmp('loop');
  try {
    fs.mkdirSync(path.join(root, '.forge-inbox', 'installed'), { recursive: true });
    fs.writeFileSync(path.join(root, '.forge-inbox', 'installed', 'x.zip'), packZip('x-pack'));
    assert.deepEqual(pendingInbox(root), []);
  } finally { cleanup(root); }
});
