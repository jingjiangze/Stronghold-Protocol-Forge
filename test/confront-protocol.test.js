import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateC2S } from '../shared/protocol.js';

const ok = (msg) => assert.equal(validateC2S(msg), null, JSON.stringify(msg));
const bad = (msg) => assert.notEqual(validateC2S(msg), null, JSON.stringify(msg));

test('g.confront: a placement of official monster keys on a gate', () => {
  ok({ t: 'g.confront', group: 1, position: 'mid', picks: [{ enemyKey: 'enemy_1422_lrsldr' }, { enemyKey: 'enemy_1427_lrnazg', gate: 'lower' }] });
  ok({ t: 'g.confront', group: null, position: 'front', picks: [], bosses: [{ enemyKey: 'enemy_1422_lrsldr' }] });
});

test('g.confront: a bad position, group, gate or empty enemyKey is refused', () => {
  bad({ t: 'g.confront', group: 1, position: 'side', picks: [] });
  bad({ t: 'g.confront', group: 17, position: 'mid', picks: [] });
  bad({ t: 'g.confront', group: 1, position: 'mid', picks: [{ enemyKey: 'enemy_1', gate: 'middle' }] });
  bad({ t: 'g.confront', group: 1, position: 'mid', picks: [{ enemyKey: '' }] });
});

test('g.confrontTarget names one player', () => {
  ok({ t: 'g.confrontTarget', targetPlayerId: 'p_1' });
  bad({ t: 'g.confrontTarget' });
});

test('g.confront.withdraw takes a positive gold amount', () => {
  ok({ t: 'g.confront.withdraw', gold: 4 });
  bad({ t: 'g.confront.withdraw', gold: 0 });
  bad({ t: 'g.confront.withdraw', gold: 100001 });
});
