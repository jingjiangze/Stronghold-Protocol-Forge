import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeBattle, chessRec } from '../helpers/battleHarness.js';

const guard = (o = {}) => chessRec({ id: 't_guard', profession: 'WARRIOR', stats: { atk: 10, blockCnt: 1 }, skill: null, ...o });

test('player obstacle placements: board coordinates are applied to this field at battleStart', () => {
  const h = makeBattle({
    players: [{
      playerId: 'p1',
      units: [],
      obstacles: [{ row: 10, col: 5, kind: 'block' }, { row: 11, col: 6, kind: 'crate' }],
    }],
    content: 'full',
  });
  h.step();
  assert.equal(h.b.grid.isObstacle(10, 5), true);
  assert.equal(h.b.grid.isObstacle(11, 6), true);
});

test('player obstacle placements: a tile with a unit is skipped', () => {
  const h = makeBattle({
    defs: { chess: { g: guard({ id: 'g' }) } },
    players: [{ playerId: 'p1', units: [{ chessId: 'g', row: 10, col: 5 }], obstacles: [{ row: 10, col: 5 }] }],
    content: 'full',
  });
  h.step();
  assert.equal(h.b.grid.isObstacle(10, 5), false);
});

test('player obstacle placements: the mirrored right boss side maps row and column', () => {
  const h = makeBattle({
    kind: 'boss',
    players: [{ playerId: 'R1', side: 'R', colOffset: 8, units: [], obstacles: [{ row: 10, col: 3 }] }],
    content: 'full',
    timeLimit: 999,
  });
  h.step();
  assert.equal(h.b.grid.isObstacle(3, 17), true);
});

test('player obstacle placements: coordinates outside the deployable field are ignored', () => {
  const h = makeBattle({
    players: [{ playerId: 'p1', units: [], obstacles: [{ row: 8, col: 5 }, { row: 10, col: 11 }] }],
    content: 'full',
  });
  h.step();
  assert.equal(h.b.grid.isObstacle(8, 5), false);
  assert.equal(h.b.grid.isObstacle(10, 11), false);
});
