// test/modSurface.test.js — 表面表守卫（Forge 的 MOD-SURFACE 范式）。
//
// 它守的不是行为，而是「说了要有」：uses 闭枚举里每多一个挂载点，表面表必须同步出现一行；
// 每个宿主方法必须真的在实现文件里；pack.msg 的协议形状必须两边都在。任何一条漂移在这里红，
// 而不是等到某个包装载时静默失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVER_MODULE_USES, PACK_CHANNEL_RE, MOD_SURFACE } from '../shared/modSurface.js';
import { C2S, S2C, PACK_MSG_LIMITS } from '../shared/protocol.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('每个 uses 挂载点在表面表里恰好一行，反之亦然', () => {
  const rows = MOD_SURFACE.filter((r) => r.use);
  const uses = rows.map((r) => r.use).sort();
  assert.deepEqual(uses, [...SERVER_MODULE_USES].sort());
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, '表面表 id 必须唯一');
});

test('每个宿主方法都在实现文件里真实存在', () => {
  for (const row of MOD_SURFACE) {
    const src = read(row.file);
    assert.ok(src.length > 0, `${row.file} 读得到`);
    if (row.host) {
      assert.ok(src.includes(row.host), `${row.file} 里应有 ${row.host}（面 ${row.id}）`);
    }
  }
  // io 门面的方法名（write/append/read/exists/remove/list）与 moduleHost 的声明同处一文件
  const mods = read('server/modModules.js');
  for (const op of ['write', 'append', 'read', 'exists', 'remove', 'list']) {
    assert.ok(mods.includes(`${op}(rel`) || mods.includes(`${op}()`) || mods.includes(`${op}(rel,`), `moduleHost 的 io.${op} 存在`);
  }
});

test('文档存在且提到每个面', () => {
  const doc = read('docs/MOD-SURFACE.md');
  for (const row of MOD_SURFACE) {
    assert.ok(doc.includes(row.id), `docs/MOD-SURFACE.md 应列出 ${row.id}`);
  }
});

test('pack.msg：协议两端 + 通道名 + 上限', () => {
  assert.ok(C2S['pack.msg'], 'C2S 有 pack.msg');
  assert.ok(S2C.includes('pack.msg'), 'S2C 有 pack.msg');
  assert.equal(C2S['pack.msg'].channel('watch'), true);
  assert.equal(C2S['pack.msg'].channel('Watch!'), false);
  assert.equal(PACK_CHANNEL_RE.test('watch'), true);
  assert.equal(PACK_CHANNEL_RE.test('Watch!'), false);
  assert.equal(PACK_MSG_LIMITS.bytes, 4096);
  assert.equal(C2S['pack.msg'].data(undefined), true, 'data 可省略');
  assert.equal(C2S['pack.msg'].data({ x: 'a'.repeat(5000) }), false, '超限拒收');
});
