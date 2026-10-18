// test/ui/skin-rows.test.js — the picker's rows (public/js/ui/skinRows.js): an operator's own record plus a content
// pack's flat `skins[<skinId>]` catalogue, in one list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skinHasModel, skinRows } from '../../public/js/ui/skinRows.js';

const model = (skel) => ({ skel });
const nestedRec = {
  illust: '/n/own.png', portrait: '/n/own_p.png', avatar: '/n/own_a.png',
  skins: {
    nested_a: { name: '嵌套 A', group: '系列甲', portrait: '/n/a.png', spine: { front: model('/n/a.skel') } },
    flat_dup: { name: '记录里的重复项', group: '记录', spine: { front: model('/n/dup.skel') } },
  },
};
const flatTable = {
  flat_a: { charId: 'char_x', name: '扁平 A', brand: '生命之地', portrait: '/f/a.png', spine: { front: model('/f/a.skel') } },
  flat_b: { charId: 'char_x', name: '扁平 B', series: '冰原', illust: '/f/b_ill.png' },
  other: { charId: 'char_y', name: '别人的', spine: { front: model('/f/o.skel') } },
  flat_dup: { charId: 'char_x', name: '扁平里的重复项', brand: '扁平' },
};

test('the flat catalogue joins the operator\'s own list, filtered by charId', () => {
  const rows = skinRows(nestedRec, flatTable, 'char_x');
  assert.deepEqual(rows.map((r) => r.id), ['', 'nested_a', 'flat_dup', 'flat_a', 'flat_b']);
  assert.equal(rows[0].own, true, 'the 默认 row is always first');
  assert.equal(rows[0].portrait, '/n/own.png', 'the operator own illustration fills the default tile');
  const flatA = rows.find((r) => r.id === 'flat_a');
  assert.equal(flatA.name, '扁平 A');
  assert.equal(flatA.group, '生命之地', 'a flat entry names its series `brand`');
  assert.equal(flatA.portrait, '/f/a.png');
  assert.equal(flatA.playable, true);
  const flatB = rows.find((r) => r.id === 'flat_b');
  assert.equal(flatB.group, '冰原', '`series` is the second name for the series');
  assert.equal(flatB.playable, false, 'art without a model is listed but not offerable');
  assert.equal(flatB.portrait, '/f/b_ill.png', 'the illustration fills the portrait tile');
  assert.equal(flatB.fallbackArt, false);
  assert.equal(rows.some((r) => r.id === 'other'), false, 'another operator\'s flat entry stays out');
});

test('a skin id both shapes write is one row: the record wins', () => {
  const rows = skinRows(nestedRec, flatTable, 'char_x');
  const dup = rows.filter((r) => r.id === 'flat_dup');
  assert.equal(dup.length, 1);
  assert.equal(dup[0].name, '记录里的重复项');
  assert.equal(dup[0].group, '记录');
});

test('a flat-only operator still gets the 默认 row, and no record at all gives nothing', () => {
  const rows = skinRows(null, flatTable, 'char_x');
  assert.deepEqual(rows.map((r) => r.id), ['', 'flat_a', 'flat_b', 'flat_dup']);
  assert.equal(rows[0].portrait, null, 'no operator art: the default tile is empty, never a placeholder');
  assert.deepEqual(skinRows(null, flatTable, 'char_z'), []);
  assert.deepEqual(skinRows(null, null, 'char_x'), []);
  assert.deepEqual(skinRows(null, flatTable, ''), []);
});

test('the model test used by the picker is the relaxed one (a front skeleton is enough)', () => {
  assert.equal(skinHasModel({ spine: { front: { skel: '/a.skel' } } }), true);
  assert.equal(skinHasModel({ spine: { front: { atlas: '/a.atlas' } } }), false);
  assert.equal(skinHasModel({ portrait: '/p.png' }), false);
  assert.equal(skinHasModel(null), false);
});
